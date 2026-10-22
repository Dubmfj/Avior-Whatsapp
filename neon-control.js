// neon-control.js
// Interruptor de la base de datos Neon vía API. Si faltan las variables, todo es no-op
// y el bot sigue funcionando (solo con el scale-to-zero normal de Neon).
//
// Variables de entorno (Render):
//   NEON_API_KEY      -> Neon Console > Account settings > API keys
//   NEON_PROJECT_ID   -> Neon Console > Project settings > General
//   NEON_ENDPOINT_ID  -> "ep-xxxx-xxxx" (es el prefijo del host de tu DATABASE_URL, sin "-pooler")
const axios = require('axios');

const API = 'https://console.neon.tech/api/v2';
const KEY = process.env.NEON_API_KEY || '';
const PROJECT = process.env.NEON_PROJECT_ID || '';
const ENDPOINT = process.env.NEON_ENDPOINT_ID || '';

const configurado = () => Boolean(KEY && PROJECT && ENDPOINT);

async function patchEndpoint(endpoint) {
    const r = await axios.patch(
        `${API}/projects/${PROJECT}/endpoints/${ENDPOINT}`,
        { endpoint },
        {
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
            timeout: 20000
        }
    );
    return r.data?.endpoint;
}

// disabled:false  -> permite que una conexión despierte la DB (NO la enciende por sí solo)
async function habilitar() {
    if (!configurado()) return;
    await patchEndpoint({ disabled: false });
}

// disabled:true -> suspende el compute ya y rechaza conexiones hasta que lo habilites
async function deshabilitar() {
    if (!configurado()) return;
    await patchEndpoint({ disabled: true });
}

// Evita que el autoscaling suba de 0.25 CU (en Free puede llegar a 2 CU y gastar 8x más horas)
async function fijarTamanoMinimo() {
    if (!configurado()) return;
    await patchEndpoint({ autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 });
}

async function estado() {
    if (!configurado()) return null;
    const r = await axios.get(`${API}/projects/${PROJECT}/endpoints/${ENDPOINT}`, {
        headers: { Authorization: `Bearer ${KEY}` },
        timeout: 20000
    });
    return r.data?.endpoint || null; // { disabled, current_state: 'idle'|'active'|..., ... }
}

module.exports = { configurado, habilitar, deshabilitar, fijarTamanoMinimo, estado };