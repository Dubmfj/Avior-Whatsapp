// auth-postgres.js
// Auth state de Baileys en PostgreSQL + "propiedad" de la sesión (una sola instancia escribe)
// + almacén clave/valor. Requiere: npm i pg
const crypto = require('crypto');
const { Pool } = require('pg');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const SESION_LOCK = 'avi';                        // nombre de la sesión protegida
const INSTANCIA_ID = crypto.randomUUID();         // identidad de ESTE proceso
const LATIDO_MS = 10 * 1000;                      // cada cuánto renueva su propiedad
const CADUCA_SEG = 45;                            // si no renueva en 45s, otra instancia puede tomarla
const FALLOS_MAX = 3;                             // 3 latidos fallidos (~30s) => esta instancia se retira

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function configPg() {
    if (!process.env.DATABASE_URL) throw new Error('Falta la variable DATABASE_URL');
    return {
        connectionString: process.env.DATABASE_URL,
        // PGSSL=off si usas la URL interna de Render; por defecto SSL sin verificar
        ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
        keepAlive: true,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000
    };
}

function crearPool() {
    return new Pool({ ...configPg(), max: 5 });
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
// PROPIEDAD DE LA SESIÓN (reemplaza al advisory lock)
// Solo UNA instancia puede ser "dueña" de la sesión de WhatsApp. El dueño renueva su
// marca de tiempo cada 10s. Si deja de renovar 45s, otra instancia puede tomarla.
// Además, TODA escritura de claves verifica que seguimos siendo dueños: una instancia
// "zombie" no puede corromper la sesión aunque algo falle. Funciona también con
// conexiones por pooler (PgBouncer), a diferencia de los advisory locks.
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
    await prepararTablas(pool);

    for (;;) {
        const r = await pool.query(
            `INSERT INTO baileys_owner (session_id, owner, beat) VALUES ($1, $2, now())
             ON CONFLICT (session_id) DO UPDATE SET owner = EXCLUDED.owner, beat = now()
             WHERE baileys_owner.owner = EXCLUDED.owner
                OR baileys_owner.beat < now() - ($3::int * interval '1 second')
             RETURNING owner`,
            [SESION_LOCK, INSTANCIA_ID, CADUCA_SEG]
        );
        if (r.rowCount === 1) break;
        console.log('⏳ Otra instancia es dueña de la sesión de WhatsApp; reintentando en 3s...');
        await dormir(3000);
    }
    console.log(`🔒 Propiedad de la sesión adquirida (instancia ${INSTANCIA_ID.slice(0, 8)}).`);

    let fallos = 0;
    const timer = setInterval(async () => {
        try {
            if (!(await renovar(pool))) {
                return salirPorPerdidaDePropiedad('Otra instancia tomó la sesión');
            }
            fallos = 0;
        } catch (e) {
            fallos++;
            console.error(`⚠️ No se pudo renovar la propiedad (${fallos}/${FALLOS_MAX}):`, e.message);
            if (fallos >= FALLOS_MAX) {
                salirPorPerdidaDePropiedad('Sin conexión estable a la base de datos');
            }
        }
    }, LATIDO_MS);

    return {
        // Se llama al apagar: deja la sesión libre al instante para la instancia nueva
        liberar: async () => {
            clearInterval(timer);
            await pool.query(
                'UPDATE baileys_owner SET beat = to_timestamp(0) WHERE session_id = $1 AND owner = $2',
                [SESION_LOCK, INSTANCIA_ID]
            );
            console.log('🔓 Propiedad de la sesión liberada.');
        }
    };
}

// -------------------------------------------------------------------------
// Auth state (reemplazo de useMultiFileAuthState)
// -------------------------------------------------------------------------
async function usePostgresAuthState(pool, sessionId = 'avi') {
    await prepararTablas(pool);

    const serializar = (v) => JSON.stringify(v, BufferJSON.replacer);
    const parsear = (s) => JSON.parse(s, BufferJSON.reviver);

    const upsert = (q, key, value) =>
        q.query(
            `INSERT INTO baileys_auth (session_id, key, value) VALUES ($1, $2, $3)
             ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value`,
            [sessionId, key, serializar(value)]
        );

    const { rows } = await pool.query(
        'SELECT value FROM baileys_auth WHERE session_id = $1 AND key = $2',
        [sessionId, 'creds']
    );
    const creds = rows[0] ? parsear(rows[0].value) : initAuthCreds();

    // Cola: las escrituras de creds se serializan para que nunca lleguen desordenadas
    let cola = Promise.resolve();
    const saveCreds = () => {
        cola = cola
            .then(async () => {
                if (!(await renovar(pool))) {
                    return salirPorPerdidaDePropiedad('Escritura de creds rechazada: ya no soy dueño de la sesión');
                }
                await upsert(pool, 'creds', creds);
            })
            .catch((e) => console.error('❌ Error guardando creds:', e.message));
        return cola;
    };

    const keys = {
        get: async (type, ids) => {
            const out = {};
            if (!ids.length) return out;
            const nombres = ids.map((id) => `${type}-${id}`);
            const res = await pool.query(
                'SELECT key, value FROM baileys_auth WHERE session_id = $1 AND key = ANY($2)',
                [sessionId, nombres]
            );
            const mapa = new Map(res.rows.map((r) => [r.key, r.value]));
            for (const id of ids) {
                const raw = mapa.get(`${type}-${id}`);
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
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // Cerco: si ya no somos dueños de la sesión, NO se escribe nada
                if (!(await renovar(client))) {
                    await client.query('ROLLBACK').catch(() => {});
                    return salirPorPerdidaDePropiedad('Escritura de claves rechazada: ya no soy dueño de la sesión');
                }
                for (const categoria of Object.keys(data)) {
                    for (const id of Object.keys(data[categoria])) {
                        const valor = data[categoria][id];
                        const key = `${categoria}-${id}`;
                        if (valor) {
                            await upsert(client, key, valor);
                        } else {
                            await client.query(
                                'DELETE FROM baileys_auth WHERE session_id = $1 AND key = $2',
                                [sessionId, key]
                            );
                        }
                    }
                }
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                client.release();
            }
        }
    };

    // Borra TODA la sesión (para cuando WhatsApp devuelve loggedOut)
    const clearAll = () =>
        pool.query('DELETE FROM baileys_auth WHERE session_id = $1', [sessionId]);

    return { state: { creds, keys }, saveCreds, clearAll };
}

// -------------------------------------------------------------------------
// Almacén clave/valor para pausas e historiales (en Render el disco se borra en cada deploy)
// -------------------------------------------------------------------------
async function kvGet(pool, clave) {
    const { rows } = await pool.query(
        "SELECT value FROM baileys_auth WHERE session_id = 'app' AND key = $1",
        [clave]
    );
    return rows[0] ? JSON.parse(rows[0].value) : null;
}

async function kvSet(pool, clave, valor) {
    await pool.query(
        `INSERT INTO baileys_auth (session_id, key, value) VALUES ('app', $1, $2)
         ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [clave, JSON.stringify(valor)]
    );
}

module.exports = {
    crearPool,
    prepararTablas,
    adquirirBloqueo,
    usePostgresAuthState,
    kvGet,
    kvSet
};