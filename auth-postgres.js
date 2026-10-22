// auth-postgres.js
// Auth state de Baileys en PostgreSQL + bloqueo de instancia única + almacén clave/valor.
// Requiere: npm i pg
const { Pool, Client } = require('pg');
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const LOCK_ID = 740123; // entero fijo, único para este bot

function configPg() {
    if (!process.env.DATABASE_URL) throw new Error('Falta la variable DATABASE_URL');
    return {
        connectionString: process.env.DATABASE_URL,
        // PGSSL=off si usas la URL interna de Render; por defecto SSL sin verificar
        ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
        keepAlive: true
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
}

// -------------------------------------------------------------------------
// Instancia única: en Render, durante un deploy corren DOS instancias a la vez.
// Dos procesos con las mismas claves Signal = ratchets desincronizados = "Esperando el mensaje".
// El advisory lock es de sesión: si el proceso muere, Postgres lo libera solo.
// OJO: usa la conexión DIRECTA, no la de PgBouncer/pooler (ahí los advisory locks no funcionan).
// -------------------------------------------------------------------------
async function adquirirBloqueo() {
    for (;;) {
        const client = new Client(configPg());
        client.on('error', (e) => {
            console.error('❌ Se perdió la conexión del bloqueo, saliendo para reiniciar limpio:', e.message);
            process.exit(1);
        });
        await client.connect();
        const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
        if (rows[0].ok) {
            console.log('🔒 Bloqueo de instancia única adquirido.');
            return client;
        }
        client.removeAllListeners('error');
        await client.end().catch(() => {});
        console.log('⏳ Otra instancia tiene la sesión de WhatsApp; reintentando en 5s...');
        await new Promise((r) => setTimeout(r, 5000));
    }
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
            .then(() => upsert(pool, 'creds', creds))
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