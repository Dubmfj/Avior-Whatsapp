// auth-postgres.js  (reemplaza al anterior; mismas exportaciones que usa tu index.js)
//
// IDEA CLAVE: Neon solo gasta horas mientras recibe consultas. Por eso:
//   - TODO se lee/escribe en MEMORIA durante el uso normal (claves Signal, creds, pausas, historiales).
//   - Los cambios se acumulan y se guardan en LOTE (flush) cada X minutos, desde db-ventana.js.
//   - No hay conexión permanente: el pool cierra conexiones inactivas a los 10 s.
//   - El "bloqueo de instancia única" ya no es un advisory lock (se pierde cuando Neon suspende):
//     es una fila "lease" que se toma al arrancar y se suelta al apagar.
//
// OJO: usa tablas NUEVAS (wa_auth, wa_kv, wa_lease). La primera vez tendrás que vincular
// WhatsApp de nuevo (código de vinculación), porque no lee el esquema de tu módulo anterior.

const { Pool } = require('pg');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Pool + consultas con reintento (el primer query tras una suspensión tarda 1-3 s)
// ---------------------------------------------------------------------------
function crearPool() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL, // con ?sslmode=require
        max: 2,
        idleTimeoutMillis: 10000,       // suelta conexiones ociosas rápido
        connectionTimeoutMillis: 30000  // tolera el arranque en frío de Neon
    });
    // Neon corta conexiones al suspender: sin este handler, 'error' tumba el proceso
    pool.on('error', (e) => console.warn('[pg] conexión inactiva cerrada:', e.message));
    return pool;
}

async function q(pool, texto, params, intentos = 4) {
    for (let i = 0; ; i++) {
        try {
            return await pool.query(texto, params);
        } catch (e) {
            if (i >= intentos - 1) throw e;
            await dormir(1500 * (i + 1));
        }
    }
}

async function asegurarTablas(pool) {
    await q(pool, `CREATE TABLE IF NOT EXISTS wa_auth (
        sesion TEXT NOT NULL, clave TEXT NOT NULL, valor TEXT NOT NULL,
        PRIMARY KEY (sesion, clave))`);
    await q(pool, `CREATE TABLE IF NOT EXISTS wa_kv (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)`);
    await q(pool, `CREATE TABLE IF NOT EXISTS wa_lease (id INT PRIMARY KEY, owner TEXT, tomado TIMESTAMPTZ)`);
}

// ---------------------------------------------------------------------------
// Instancia única (lease). Se toma al arrancar, se suelta al apagar. Sin heartbeat:
// un heartbeat mantendría Neon despierto. Si la instancia anterior murió sin soltarla,
// esperamos esperaMaxMs y la tomamos a la fuerza.
// ---------------------------------------------------------------------------
async function adquirirBloqueo(pool, esperaMaxMs = 120000) {
    await asegurarTablas(pool);
    const limite = Date.now() + esperaMaxMs;
    for (;;) {
        const r = await q(pool,
            `INSERT INTO wa_lease (id, owner, tomado) VALUES (1, $1, now())
             ON CONFLICT (id) DO UPDATE SET owner = $1, tomado = now()
             WHERE wa_lease.owner IS NULL OR wa_lease.owner = $1
             RETURNING owner`, [OWNER]);
        if (r.rowCount > 0) break;
        if (Date.now() > limite) {
            console.warn('⚠️ La instancia anterior no soltó la sesión a tiempo. Tomándola a la fuerza.');
            await q(pool, `UPDATE wa_lease SET owner = $1, tomado = now() WHERE id = 1`, [OWNER]);
            break;
        }
        console.log('⏳ Esperando que la instancia anterior suelte la sesión de WhatsApp...');
        await dormir(5000);
    }
    return {
        liberar: async () => {
            await q(pool, `UPDATE wa_lease SET owner = NULL WHERE id = 1 AND owner = $1`, [OWNER], 2);
        }
    };
}

// ---------------------------------------------------------------------------
// Auth de Baileys: carga todo UNA vez, trabaja en memoria, guarda en lote
// ---------------------------------------------------------------------------
const sesiones = new Map(); // sesion -> estado (reutilizado entre reconexiones de Baileys)

async function usePostgresAuthState(pool, sesion) {
    if (sesiones.has(sesion)) return sesiones.get(sesion); // reconexión: NO vuelve a leer la DB

    const cache = new Map();   // clave -> valor
    const sucias = new Set();  // claves con cambios sin guardar

    const r = await q(pool, 'SELECT clave, valor FROM wa_auth WHERE sesion = $1', [sesion]);
    for (const f of r.rows) {
        try { cache.set(f.clave, JSON.parse(f.valor, BufferJSON.reviver)); } catch (e) {}
    }

    let creds = cache.get('creds');
    if (!creds) {
        creds = initAuthCreds();
        cache.set('creds', creds);
        sucias.add('creds');
    }

    const keys = {
        get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
                let v = cache.get(`${type}-${id}`);
                if (type === 'app-state-sync-key' && v) {
                    v = proto.Message.AppStateSyncKeyData.fromObject(v);
                }
                data[id] = v;
            }
            return data;
        },
        set: async (data) => {
            for (const type in data) {
                for (const id in data[type]) {
                    const k = `${type}-${id}`;
                    const v = data[type][id];
                    if (v) cache.set(k, v); else cache.delete(k);
                    sucias.add(k);
                }
            }
        }
    };

    async function flush() {
        if (!sucias.size) return 0;
        const lote = [...sucias];
        sucias.clear();
        const upK = [], upV = [], del = [];
        for (const k of lote) {
            const v = cache.get(k);
            if (v === undefined) del.push(k);
            else { upK.push(k); upV.push(JSON.stringify(v, BufferJSON.replacer)); }
        }
        try {
            if (upK.length) {
                await q(pool,
                    `INSERT INTO wa_auth (sesion, clave, valor)
                     SELECT $1, t.k, t.v FROM unnest($2::text[], $3::text[]) AS t(k, v)
                     ON CONFLICT (sesion, clave) DO UPDATE SET valor = EXCLUDED.valor`,
                    [sesion, upK, upV]);
            }
            if (del.length) {
                await q(pool, `DELETE FROM wa_auth WHERE sesion = $1 AND clave = ANY($2::text[])`, [sesion, del]);
            }
        } catch (e) {
            for (const k of lote) sucias.add(k); // no perder cambios si la DB estaba apagada
            throw e;
        }
        return lote.length;
    }

    // Mientras la cuenta no esté vinculada, guarda de inmediato (un fallo aquí obliga a re-escanear)
    let sinRegistrar = !creds.registered;
    const saveCreds = async () => {
        sucias.add('creds');
        if (sinRegistrar) {
            try { await flush(); } catch (e) { console.error('No se pudo guardar creds:', e.message); }
            if (creds.registered) sinRegistrar = false;
        }
    };

    const clearAll = async () => {
        cache.clear();
        sucias.clear();
        sesiones.delete(sesion);
        await q(pool, 'DELETE FROM wa_auth WHERE sesion = $1', [sesion]);
    };

    const estado = {
        state: { creds, keys },
        saveCreds,
        clearAll,
        flush,
        pendiente: () => sucias.size,
        registrado: () => Boolean(creds.registered),
        descartar: () => sucias.clear()
    };
    sesiones.set(sesion, estado);
    return estado;
}

// ---------------------------------------------------------------------------
// Almacén clave/valor (pausas, historiales): memoria primero, guardado en lote
// ---------------------------------------------------------------------------
const kvCache = new Map();
const kvSucias = new Set();

async function kvGet(pool, clave) {
    if (kvCache.has(clave)) return kvCache.get(clave);
    const r = await q(pool, 'SELECT valor FROM wa_kv WHERE clave = $1', [clave]);
    if (!r.rows[0]) return null;
    const v = JSON.parse(r.rows[0].valor);
    kvCache.set(clave, v);
    return v;
}

async function kvSet(pool, clave, valor) {
    kvCache.set(clave, valor);
    kvSucias.add(clave);
}

async function flushKV(pool) {
    if (!kvSucias.size) return 0;
    const lote = [...kvSucias];
    kvSucias.clear();
    try {
        for (const k of lote) {
            await q(pool,
                `INSERT INTO wa_kv (clave, valor) VALUES ($1, $2)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
                [k, JSON.stringify(kvCache.get(k))]);
        }
    } catch (e) {
        for (const k of lote) kvSucias.add(k);
        throw e;
    }
    return lote.length;
}

// ---------------------------------------------------------------------------
// Guardado global
// ---------------------------------------------------------------------------
let enCurso = null;

function flushTodo(pool) {
    if (enCurso) return enCurso;
    enCurso = (async () => {
        let n = 0;
        for (const s of sesiones.values()) n += await s.flush();
        n += await flushKV(pool);
        return n;
    })().finally(() => { enCurso = null; });
    return enCurso;
}

function hayPendiente() {
    if (kvSucias.size > 0) return true;
    for (const s of sesiones.values()) if (s.pendiente() > 0) return true;
    return false;
}

// Úsalo si otra instancia tomó la sesión (connectionReplaced): NO sobrescribas sus claves
function descartarPendiente() {
    kvSucias.clear();
    for (const s of sesiones.values()) s.descartar();
}

function sesionRegistrada() {
    for (const s of sesiones.values()) if (!s.registrado()) return false;
    return true;
}

module.exports = {
    crearPool,
    adquirirBloqueo,
    usePostgresAuthState,
    kvGet,
    kvSet,
    flushTodo,
    hayPendiente,
    descartarPendiente,
    sesionRegistrada
};