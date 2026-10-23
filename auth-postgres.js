// auth-postgres.js  (versión con "guardado en lote" para usar con db-ventana.js)
//
// Idea: la sesión de WhatsApp (claves Signal, creds), las pausas y los historiales viven en
// MEMORIA mientras el bot corre. Solo se escriben en Postgres (Neon) cuando db-ventana.js
// llama a flushTodo(), y al apagar. Así Neon puede estar suspendida casi todo el día.
//
// Qué protege la "propiedad de la sesión" (tabla baileys_owner):
//   - Al arrancar, esta instancia ESPERA a que la anterior termine de guardar y suelte la sesión.
//     Si pasan ESPERA_PROPIEDAD_SEG (90 s) sin que la suelte (se cayó de golpe), la toma a la fuerza.
//   - Cada guardado verifica que seguimos siendo dueños. Si otra instancia tomó la sesión,
//     NO se escribe nada, se descarta lo pendiente y el proceso se cierra.
//
// Requiere: npm i pg
const crypto = require('crypto');
const { Pool } = require('pg');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const SESION_LOCK = 'avi';                         // clave de la fila de propiedad
const INSTANCIA_ID = crypto.randomUUID();          // identidad de ESTE proceso
const ESPERA_MAX_SEG = Number(process.env.ESPERA_PROPIEDAD_SEG) || 90;
const LOTE_MAX = 500;                              // filas por consulta al guardar

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const serializar = (v) => JSON.stringify(v, BufferJSON.replacer);
const parsear = (s) => JSON.parse(s, BufferJSON.reviver);

function configPg() {
    if (!process.env.DATABASE_URL) throw new Error('Falta la variable DATABASE_URL');
    return {
        connectionString: process.env.DATABASE_URL,
        // PGSSL=off si usas la URL interna de Render; por defecto SSL sin verificar
        ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
        keepAlive: true,
        connectionTimeoutMillis: 15000,   // despertar Neon puede tardar unos segundos
        query_timeout: 20000
    };
}

function crearPool() {
    const pool = new Pool({ ...configPg(), max: 5 });
    // Cuando Neon se deshabilita/suspende, cierra las conexiones inactivas: es normal, no es un fallo.
    pool.on('error', (e) => console.warn('⚠️ Conexión inactiva de Postgres cerrada (normal si Neon se suspendió):', e.message));
    return pool;
}

async function prepararTablas(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_auth (
            session_id TEXT NOT NULL,
            key        TEXT NOT NULL,
            value      TEXT NOT NULL,
            PRIMARY KEY (session_id, key)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_owner (
            session_id TEXT PRIMARY KEY,
            owner      TEXT NOT NULL,
            beat       TIMESTAMPTZ NOT NULL
        )`);
}

// -------------------------------------------------------------------------
// Estado en memoria + cambios pendientes de guardar
// -------------------------------------------------------------------------
let poolRef = null;
let sesion = null;                 // { id, api }  -> se reutiliza en reconexiones (no relee la base)
let sesionId = 'avi';
let credsActual = null;            // objeto creds vivo de Baileys
let pendKeys = new Map();          // clave -> texto JSON | null (null = borrar)
let pendKv = new Set();            // claves de pausas/historiales pendientes
const kvMem = new Map();           // pausas/historiales en memoria
let credsPend = false;
let borrarSesion = false;          // pedido de borrar toda la sesión (loggedOut)
let flushEnCurso = null;

function hayPendiente() {
    return pendKeys.size > 0 || pendKv.size > 0 || credsPend || borrarSesion;
}

// Se usa cuando otra instancia tomó la sesión: nuestras claves serían viejas y pisarían las suyas
function descartarPendiente() {
    pendKeys = new Map();
    pendKv = new Set();
    credsPend = false;
    borrarSesion = false;
}

// -------------------------------------------------------------------------
// Propiedad de la sesión
// -------------------------------------------------------------------------
function salirPorPerdidaDePropiedad(motivo) {
    console.error(`❌ ${motivo}. Saliendo para que Render reinicie esta instancia limpia.`);
    process.exit(1);
}

async function renovar(q) {
    const r = await q.query(
        'UPDATE baileys_owner SET beat = now() WHERE session_id = $1 AND owner = $2',
        [SESION_LOCK, INSTANCIA_ID]
    );
    return r.rowCount === 1;
}

async function adquirirBloqueo(pool) {
    poolRef = pool;
    await prepararTablas(pool);
    const inicio = Date.now();

    for (;;) {
        // Se adquiere si no hay dueño, si ya somos nosotros, o si el dueño anterior la soltó
        // (beat = epoch, que es como la dejaba la versión anterior al apagarse)
        const r = await pool.query(
            `INSERT INTO baileys_owner (session_id, owner, beat) VALUES ($1, $2, now())
             ON CONFLICT (session_id) DO UPDATE SET owner = EXCLUDED.owner, beat = now()
             WHERE baileys_owner.owner = EXCLUDED.owner
                OR baileys_owner.beat <= to_timestamp(0)
             RETURNING owner`,
            [SESION_LOCK, INSTANCIA_ID]
        );
        if (r.rowCount === 1) break;

        if (Date.now() - inicio >= ESPERA_MAX_SEG * 1000) {
            console.warn(`⚠️ La instancia anterior no soltó la sesión en ${ESPERA_MAX_SEG}s (¿se cayó?). Tomándola.`);
            await pool.query(
                `INSERT INTO baileys_owner (session_id, owner, beat) VALUES ($1, $2, now())
                 ON CONFLICT (session_id) DO UPDATE SET owner = EXCLUDED.owner, beat = now()`,
                [SESION_LOCK, INSTANCIA_ID]
            );
            break;
        }
        console.log('⏳ Otra instancia es dueña de la sesión de WhatsApp; esperando que termine de guardar...');
        await dormir(3000);
    }
    console.log(`🔒 Propiedad de la sesión adquirida (instancia ${INSTANCIA_ID.slice(0, 8)}).`);

    return {
        // Se llama al apagar, DESPUÉS de guardar: deja la sesión libre al instante para la instancia nueva
        liberar: async () => {
            await pool.query(
                'DELETE FROM baileys_owner WHERE session_id = $1 AND owner = $2',
                [SESION_LOCK, INSTANCIA_ID]
            );
            console.log('🔓 Propiedad de la sesión liberada.');
        }
    };
}

// -------------------------------------------------------------------------
// Auth state en memoria (reemplazo de useMultiFileAuthState)
// -------------------------------------------------------------------------
async function usePostgresAuthState(pool, sessionId = 'avi') {
    poolRef = pool;
    // Reconexión: se reutiliza la sesión que ya está en memoria (no se vuelve a leer la base)
    if (sesion && sesion.id === sessionId) return sesion.api;

    await prepararTablas(pool);
    sesionId = sessionId;

    const store = new Map();   // clave -> texto JSON
    let creds = null;
    if (!borrarSesion) {
        const { rows } = await pool.query(
            'SELECT key, value FROM baileys_auth WHERE session_id = $1',
            [sessionId]
        );
        for (const r of rows) {
            if (r.key === 'creds') creds = parsear(r.value);
            else store.set(r.key, r.value);
        }
    }
    if (!creds) {
        creds = initAuthCreds();
        credsPend = true;     // identidad nueva: hay que guardarla
    }
    credsActual = creds;

    const estaVinculado = () => Boolean(creds.registered || creds.me?.id);
    let urgenteHecho = estaVinculado();

    const keys = {
        get: async (type, ids) => {
            const out = {};
            for (const id of ids) {
                const raw = store.get(`${type}-${id}`);
                if (!raw) continue;
                let v = parsear(raw);
                if (type === 'app-state-sync-key' && v) {
                    v = proto.Message.AppStateSyncKeyData.fromObject(v);
                }
                out[id] = v;
            }
            return out;
        },
        set: async (data) => {
            for (const categoria of Object.keys(data)) {
                for (const id of Object.keys(data[categoria])) {
                    const valor = data[categoria][id];
                    const key = `${categoria}-${id}`;
                    if (valor) {
                        const texto = serializar(valor);
                        store.set(key, texto);
                        pendKeys.set(key, texto);
                    } else {
                        store.delete(key);
                        pendKeys.set(key, null);
                    }
                }
            }
        }
    };

    const saveCreds = async () => {
        credsPend = true;
        // Justo al vincular WhatsApp se guarda enseguida (no esperar al guardado periódico):
        // si Render reiniciara en ese rato, habría que vincular otra vez.
        if (!urgenteHecho && estaVinculado()) {
            urgenteHecho = true;
            setTimeout(() => {
                flushTodo(poolRef).catch((e) => console.error('❌ Falló el guardado tras vincular:', e?.message || e));
            }, 2000);
        }
    };

    // Borra TODA la sesión (WhatsApp devolvió loggedOut). Si la base está apagada ahora,
    // el borrado queda pendiente y se aplica en el próximo guardado.
    const clearAll = async () => {
        store.clear();
        pendKeys = new Map();
        credsPend = false;
        credsActual = null;
        sesion = null;
        borrarSesion = true;
        try { await flushTodo(poolRef); } catch (e) {
            console.error('No se pudo borrar la sesión en la base ahora; queda pendiente:', e?.message || e);
        }
    };

    const api = {
        state: { creds, keys },
        saveCreds,
        clearAll,
        registrado: estaVinculado
    };
    sesion = { id: sessionId, api };
    return api;
}

// -------------------------------------------------------------------------
// Pausas e historiales (en memoria; se guardan en lote)
// -------------------------------------------------------------------------
async function kvGet(pool, clave) {
    if (kvMem.has(clave)) return kvMem.get(clave);
    const { rows } = await (pool || poolRef).query(
        "SELECT value FROM baileys_auth WHERE session_id = 'app' AND key = $1",
        [clave]
    );
    if (!rows[0]) return null;
    const valor = JSON.parse(rows[0].value);
    kvMem.set(clave, valor);
    return valor;
}

async function kvSet(pool, clave, valor) {
    kvMem.set(clave, valor);
    pendKv.add(clave);
}

// -------------------------------------------------------------------------
// Guardado en lote en Postgres. Devuelve cuántos registros se escribieron.
// -------------------------------------------------------------------------
async function escribirLote(client, filas) {
    for (let i = 0; i < filas.length; i += LOTE_MAX) {
        const parte = filas.slice(i, i + LOTE_MAX);
        await client.query(
            `INSERT INTO baileys_auth (session_id, key, value)
             SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
             ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [parte.map((f) => f[0]), parte.map((f) => f[1]), parte.map((f) => f[2])]
        );
    }
}

async function ejecutarFlush(pool) {
    // Se toma una "foto" de lo pendiente; lo que llegue mientras se guarda queda para el siguiente guardado
    const claves = pendKeys; pendKeys = new Map();
    const kvs = pendKv; pendKv = new Set();
    const credsSucio = credsPend; credsPend = false;
    const borrar = borrarSesion; borrarSesion = false;
    const sid = sesionId;
    const credsTexto = credsSucio && credsActual ? serializar(credsActual) : null;

    const restaurar = () => {
        for (const [k, v] of claves) if (!pendKeys.has(k)) pendKeys.set(k, v);
        for (const k of kvs) pendKv.add(k);
        if (credsSucio) credsPend = true;
        if (borrar) borrarSesion = true;
    };

    let client;
    let perdida = false;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Cerco: si ya no somos dueños de la sesión, NO se escribe nada
        if (!(await renovar(client))) {
            perdida = true;
            await client.query('ROLLBACK').catch(() => {});
            descartarPendiente();
            return salirPorPerdidaDePropiedad('Guardado rechazado: ya no soy dueño de la sesión');
        }

        if (borrar) await client.query('DELETE FROM baileys_auth WHERE session_id = $1', [sid]);

        const filas = [];
        const borrados = [];
        if (credsTexto) filas.push([sid, 'creds', credsTexto]);
        for (const [k, v] of claves) {
            if (v === null) borrados.push(k);
            else filas.push([sid, k, v]);
        }
        for (const c of kvs) {
            if (kvMem.has(c)) filas.push(['app', c, JSON.stringify(kvMem.get(c))]);
        }

        await escribirLote(client, filas);
        if (borrados.length) {
            await client.query(
                'DELETE FROM baileys_auth WHERE session_id = $1 AND key = ANY($2)',
                [sid, borrados]
            );
        }
        await client.query('COMMIT');
        return filas.length + borrados.length;
    } catch (e) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (!perdida) restaurar();   // fallo normal: no se pierde nada, se reintenta en el próximo guardado
        throw e;
    } finally {
        if (client) client.release();
    }
}

async function flushTodo(pool) {
    // Si ya hay un guardado en curso, se espera y luego se guarda lo que haya llegado después
    while (flushEnCurso) {
        try { await flushEnCurso; } catch (e) {}
    }
    if (!hayPendiente()) return 0;
    flushEnCurso = ejecutarFlush(pool || poolRef);
    try {
        return await flushEnCurso;
    } finally {
        flushEnCurso = null;
    }
}

module.exports = {
    crearPool,
    prepararTablas,
    adquirirBloqueo,
    usePostgresAuthState,
    kvGet,
    kvSet,
    flushTodo,
    hayPendiente,
    descartarPendiente
};