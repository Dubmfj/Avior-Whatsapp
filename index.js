// index.js — Avi (Scroll Studios)
// WhatsApp (Baileys) + Gemini directo + sesión, pausas e historiales en Postgres (Neon) + panel web /admin
const crypto = require('crypto');
const http = require('http');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    normalizeMessageContent,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const PROMPT_SISTEMA_AVI = require('./prompt-avi');
const {
    crearPool,
    adquirirBloqueo,
    usePostgresAuthState,
    kvGet,
    kvSet,
    descartarPendiente
} = require('./auth-postgres');
const dbVentana = require('./db-ventana');

// =========================================================================
// 0. CONFIGURACIÓN
// =========================================================================
const PORT = process.env.PORT || 10000;

// Clave para entrar a /qr y /admin. Ejemplo: https://TU-SERVICIO.onrender.com/admin?key=11112009
// Está FIJA aquí a propósito: no depende de la variable QR_TOKEN de Render (si existe con otro
// valor, se ignora). Para cambiarla, edita esta línea y vuelve a desplegar.
const QR_TOKEN = '11112009';

const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';   // 'info' para depurar
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/\D/g, '');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Número desde el que puedes mandarle comandos al bot (solo dígitos con código de país).
// Define ADMIN_NUMBER en Render con tu OTRO número, ej: 51922501122
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const NUMEROS_ADMIN = ADMIN_NUMBER ? [ADMIN_NUMBER] : [];

const MI_CHAT_PERSONAL = '51987355501@s.whatsapp.net';
const MENSAJE_ERROR = 'Hola, ocurrió un inconveniente temporal en el servidor. Por favor intenta de nuevo en un momento.';

// Horario automático del bot (hora de Lima): 10:00 PM a 6:30 AM
const BOT_INICIO_MIN = 22 * 60;
const BOT_FIN_MIN = 6 * 60 + 30;

const COMANDOS_ADMIN = [
    '!unpause', '!despausar', '!unpause all', '!despausar todo', '!admin', '!help',
    '!bot on', '!bot off', '!bot auto', '!bot status',
    '!db on', '!db off', '!db auto', '!db status', '!db flush'
];
const COMANDOS_PANEL = [
    '!bot status', '!bot on', '!bot off', '!unpause all',
    '!db status', '!db flush', '!db on', '!db auto', '!db off'
];
const TIPOS_TECNICOS = [
    'protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage',
    'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage'
];

// =========================================================================
// 1. ESTADO EN MEMORIA
// =========================================================================
let chatsPausados = {};
let historialesChats = {};
const registroSpam = {};
let ignorarHorario = false;      // true = activado a mano con !bot on (24/7)

let latestQR = '';
let latestPairingCode = '';
let conectado = false;

let pool = null;
let lockClient = null;
let authActual = null;
let apagando = false;
let sockActual = null;
let reconexionProgramada = false;
let intentos = 0;

// Mensajes que envió el propio bot: id -> contenido (sirve para no confundirlos con una
// intervención tuya y para que Baileys pueda reenviarlos si el cliente pide un reintento)
const enviados = new Map();

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Alertas recientes (se ven en /admin; se pierden al reiniciar)
const alertas = [];
function registrarAlerta(texto) {
    const hora = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
    alertas.unshift(`${hora} — ${texto}`);
    if (alertas.length > 20) alertas.pop();
}

function esc(t) {
    return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Un chat a la vez: si un cliente manda varios mensajes seguidos, se procesan en orden
// (si no, las respuestas de Gemini se cruzan y el historial queda desordenado)
const colas = new Map();
function enCola(clave, tarea) {
    const previa = colas.get(clave) || Promise.resolve();
    const actual = previa.then(tarea, tarea);
    colas.set(clave, actual);
    const limpiar = () => { if (colas.get(clave) === actual) colas.delete(clave); };
    actual.then(limpiar, limpiar);
    return actual;
}

// =========================================================================
// 2. IDENTIDAD (WhatsApp usa número y LID)
// =========================================================================
function aNumero(n) {
    if (!n) return 0;
    if (typeof n === 'number') return n;
    if (typeof n === 'object') return typeof n.toNumber === 'function' ? n.toNumber() : (n.low || 0);
    return Number(n) || 0;
}

function soloNumero(jid) {
    return String(jid || '').split('@')[0].split(':')[0];
}

function esChatPropio(sock, jid) {
    if (!sock) return false;
    const propios = [MI_CHAT_PERSONAL];
    if (sock.user?.id) propios.push(jidNormalizedUser(sock.user.id));
    if (sock.user?.lid) propios.push(jidNormalizedUser(sock.user.lid));
    return propios.includes(jid);
}

// A dónde mandar notificaciones y respuestas de admin
function miChat(sock) {
    if (ADMIN_NUMBER) return `${ADMIN_NUMBER}@s.whatsapp.net`;
    return sock?.user?.lid ? jidNormalizedUser(sock.user.lid) : MI_CHAT_PERSONAL;
}

// =========================================================================
// 3. SERVIDOR HTTP (estado, /qr y /admin)
// =========================================================================
const CSS = `
body{margin:0;padding:20px;background:#111;color:#fff;font-family:sans-serif}
h1{font-size:20px}
.c{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90vh;text-align:center}
.b{display:inline-block;margin:4px;padding:12px 16px;background:#1f6feb;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}
pre{background:#1b1b1b;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word}
.m{color:#aaa;font-size:14px}`;

function pagina(titulo, cuerpo, refresco = 0) {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresco ? `<meta http-equiv="refresh" content="${refresco}">` : ''}
<title>${esc(titulo)}</title><style>${CSS}</style></head><body>${cuerpo}</body></html>`;
}

function responder(res, codigo, tipo, cuerpo) {
    res.writeHead(codigo, { 'Content-Type': `${tipo}; charset=utf-8` });
    res.end(cuerpo);
}

// Comparación de la clave en tiempo constante + freno a los intentos fallidos
// (tras 100 fallos en 10 minutos, /qr y /admin se bloquean hasta que pase la ventana)
function claveValida(k) {
    const a = Buffer.from(String(k || ''));
    const b = Buffer.from(QR_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const VENTANA_FALLOS_MS = 10 * 60 * 1000;
let fallos = { n: 0, desde: 0 };
function accesoBloqueado() {
    return fallos.n >= 100 && Date.now() - fallos.desde < VENTANA_FALLOS_MS;
}
function anotarFallo() {
    const t = Date.now();
    if (t - fallos.desde >= VENTANA_FALLOS_MS) fallos = { n: 0, desde: t };
    fallos.n++;
}

// Devuelve true si deja pasar; si no, ya respondió el error
function autorizar(res, url) {
    if (accesoBloqueado()) {
        responder(res, 429, 'text/plain', 'Demasiados intentos. Espera unos minutos.');
        return false;
    }
    if (!claveValida(url.searchParams.get('key'))) {
        anotarFallo();
        responder(res, 403, 'text/plain', 'Acceso denegado. La clave del link no coincide.');
        return false;
    }
    return true;
}

function leerCuerpo(req) {
    return new Promise((ok, fail) => {
        let datos = '';
        req.on('data', (c) => {
            datos += c;
            if (datos.length > 2000) { req.destroy(); fail(new Error('Cuerpo demasiado grande')); }
        });
        req.on('end', () => ok(datos));
        req.on('error', fail);
    });
}

async function ejecutarDesdePanel(cmd) {
    if (!cmd) return '';
    if (!COMANDOS_PANEL.includes(cmd)) return 'Comando no permitido.';
    const partes = [];
    try {
        await ejecutarComando(null, cmd, 'panel', 'panel', null, (t) => partes.push(t));
        return partes.join('\n\n') || 'Hecho.';
    } catch (e) {
        return 'Error: ' + (e?.message || e);
    }
}

async function rutaAdmin(req, res, url) {
    if (!autorizar(res, url)) return;

    let salida = '';
    if (req.method === 'POST') {
        const cmd = (new URLSearchParams(await leerCuerpo(req)).get('cmd') || '').toLowerCase().trim();
        salida = await ejecutarDesdePanel(cmd);
    }

    const k = encodeURIComponent(QR_TOKEN);
    const botones = COMANDOS_PANEL.map((c) => `<button class="b" name="cmd" value="${esc(c)}">${esc(c)}</button>`).join('');
    responder(res, 200, 'text/html', pagina('Avi - Panel', `
<h1>🤖 Panel de Avi</h1>
<p class="m">WhatsApp: <b>${conectado ? 'conectado ✅' : 'desconectado ❌'}</b> ·
Modo: <b>${ignorarHorario ? 'activado a mano (24/7)' : 'automático (10 PM - 6:30 AM)'}</b> ·
Respondiendo ahora: <b>${esHorarioDeBot() ? 'sí' : 'no'}</b> ·
Chats pausados: <b>${Object.keys(chatsPausados).length}</b></p>
<form method="post" action="/admin?key=${k}">${botones}</form>
${salida ? `<h3>Resultado</h3><pre>${esc(salida)}</pre>` : ''}
<h3>Alertas recientes</h3>
<pre>${alertas.length ? esc(alertas.join('\n')) : 'Sin alertas desde el último reinicio.'}</pre>`));
}

async function rutaQR(res, url) {
    if (!autorizar(res, url)) return;

    if (latestPairingCode) {
        return responder(res, 200, 'text/html', pagina('Avi - Código de vinculación', `<div class="c">
<h1>Código de vinculación para Avi</h1>
<div style="font-size:56px;letter-spacing:8px;font-weight:bold;background:#fff;color:#111;padding:20px 30px;border-radius:12px">${esc(latestPairingCode)}</div>
<p class="m" style="max-width:420px;margin-top:24px">En WhatsApp: Dispositivos vinculados → Vincular dispositivo → <b>Vincular con el número de teléfono</b> → escribe este código.</p></div>`, 20));
    }
    if (latestQR) {
        const dataUrl = await QRCode.toDataURL(latestQR, { width: 300, margin: 1 });
        return responder(res, 200, 'text/html', pagina('Avi - Escanear QR', `<div class="c">
<h1>Escanea el QR para Avi (Scroll Studios)</h1>
<img src="${dataUrl}" alt="QR WhatsApp" style="border:10px solid #fff;border-radius:10px;background:#fff"/>
<p class="m">La página se actualiza sola cada 15 segundos.</p></div>`, 15));
    }
    const estado = conectado ? '¡Avi ya está vinculado y en línea!' : 'Esperando el código QR... recarga en unos segundos.';
    responder(res, 200, 'text/html', pagina('Avi WhatsApp Bot', `<div class="c"><h1>${estado}</h1></div>`, 10));
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname === '/admin') return await rutaAdmin(req, res, url);
        if (url.pathname === '/qr') return await rutaQR(res, url);
        responder(res, 200, 'text/plain', `Avi WhatsApp Bot - Service Active | WhatsApp: ${conectado ? 'conectado' : 'desconectado'}`);
    } catch (e) {
        console.error('HTTP:', e?.message || e);
        if (!res.headersSent) responder(res, 500, 'text/plain', 'Error interno');
        else res.end();
    }
});

server.listen(PORT, () => console.log(`🌐 Servidor HTTP activo en el puerto ${PORT}`));

// Auto-ping para que Render free no duerma el servicio (no toca la base de datos)
if (SELF_URL) {
    setInterval(() => {
        fetch(SELF_URL, { signal: AbortSignal.timeout(15000) }).catch(() => {});
    }, 10 * 60 * 1000);
}

// Limpieza periódica del registro anti-spam (si no, crece con cada número nuevo)
setInterval(() => {
    const limite = Date.now() - 10000;
    for (const jid of Object.keys(registroSpam)) {
        registroSpam[jid] = registroSpam[jid].filter((t) => t > limite);
        if (!registroSpam[jid].length) delete registroSpam[jid];
    }
}, 10 * 60 * 1000).unref();

// =========================================================================
// 4. PERSISTENCIA (pausas e historiales; auth-postgres los guarda en lote)
// =========================================================================
async function cargarMemoria() {
    try {
        chatsPausados = (await kvGet(pool, 'pausas')) || {};
        historialesChats = (await kvGet(pool, 'historiales')) || {};
        console.log('📦 Pausas e historiales cargados desde Postgres.');
    } catch (e) {
        console.error('Error al cargar memoria:', e?.message || e);
    }
}

const guardarPausas = () => kvSet(pool, 'pausas', chatsPausados).catch((e) => console.error('Error al guardar pausas:', e?.message));

function agregarMensajeAHistorial(userId, rol, texto) {
    const lista = historialesChats[userId] || (historialesChats[userId] = []);
    lista.push({ role: rol, content: texto });
    if (lista.length > 6) historialesChats[userId] = lista.slice(-6);
    kvSet(pool, 'historiales', historialesChats).catch((e) => console.error('Error al guardar historiales:', e?.message));
}

// =========================================================================
// 5. HORARIO
// =========================================================================
function enHorarioAutomatico() {
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Lima', hourCycle: 'h23', hour: 'numeric', minute: 'numeric'
    }).formatToParts(new Date());
    const hora = parseInt(partes.find((p) => p.type === 'hour').value, 10) % 24;
    const minuto = parseInt(partes.find((p) => p.type === 'minute').value, 10);
    const total = hora * 60 + minuto;
    return total >= BOT_INICIO_MIN || total < BOT_FIN_MIN;   // cruza la medianoche
}

const esHorarioDeBot = () => ignorarHorario || enHorarioAutomatico();

function estaChatPausado(chatId) {
    if (!chatsPausados[chatId]) return false;
    if (Date.now() > chatsPausados[chatId]) {
        delete chatsPausados[chatId];
        guardarPausas();
        return false;
    }
    return true;
}

// =========================================================================
// 6. GEMINI
// =========================================================================
let clienteGemini = null;
async function obtenerGemini() {
    if (!GEMINI_API_KEY) throw new Error('Falta la variable GEMINI_API_KEY en Render');
    if (!clienteGemini) {
        const { GoogleGenAI } = await import('@google/genai');
        clienteGemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
    return clienteGemini;
}

// Gemini exige turnos alternados (cliente / modelo): une los seguidos del mismo rol
// (pasa cuando una respuesta anterior falló) y exige que empiece con el cliente
function armarContenido(historial) {
    const contents = [];
    for (const m of historial) {
        const role = m.role === 'model' ? 'model' : 'user';
        const text = String(m.content ?? '').trim();
        if (!text) continue;
        const ultimo = contents[contents.length - 1];
        if (ultimo && ultimo.role === role) ultimo.parts[0].text += '\n' + text;
        else contents.push({ role, parts: [{ text }] });
    }
    while (contents.length && contents[0].role !== 'user') contents.shift();
    return contents;
}

function conTimeout(promesa, ms) {
    let t;
    const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Gemini tardó demasiado')), ms); });
    return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
}

async function responderConGemini(historial) {
    const gemini = await obtenerGemini();
    const contents = armarContenido(historial);
    for (let i = 1; ; i++) {
        try {
            const r = await conTimeout(gemini.models.generateContent({
                model: GEMINI_MODEL,
                contents,
                config: { systemInstruction: PROMPT_SISTEMA_AVI }
            }), 60000);
            return String(r.text || '').trim();
        } catch (e) {
            if ((e?.status === 503 || e?.status === 429) && i < 3) {
                console.warn(`[Gemini ${e.status}] reintentando (${i}/3)...`);
                await esperar(1500 * i);
                continue;
            }
            throw e;
        }
    }
}

// =========================================================================
// 7. ENVÍO Y COMANDOS ADMIN
// =========================================================================
async function enviar(sock, jid, contenido, opciones) {
    const enviado = await sock.sendMessage(jid, contenido, opciones);
    const id = enviado?.key?.id;
    if (id) {
        enviados.set(id, enviado.message || null);
        if (enviados.size > 1000) enviados.delete(enviados.keys().next().value);
    }
    return enviado;
}

async function ejecutarComando(sock, comando, chatId, numeroReal, destino, salida) {
    // Con 'salida' (panel web) no se manda nada por WhatsApp
    const responder = salida ? (t) => salida(t) : (t) => enviar(sock, destino || miChat(sock), { text: t });

    if (comando === '!bot on') {
        ignorarHorario = true;
        await dbVentana.comando('!db on');
        return responder('✅ *BOT ACTIVADO A MANO.* Responde 24/7 y Neon queda habilitado.\nCuando termines escribe *!bot off* para volver al horario (10 PM - 6:30 AM).');
    }
    if (comando === '!bot off' || comando === '!bot auto') {
        ignorarHorario = false;
        const msg = await dbVentana.comando('!db auto');
        return responder('🌙 *BOT EN AUTOMÁTICO.* Solo responde de 10:00 PM a 6:30 AM; fuera de ese horario queda apagado.\n' + msg);
    }
    if (comando === '!bot status') {
        return responder(
            `🤖 *BOT:* ${ignorarHorario ? 'ACTIVADO A MANO (24/7)' : 'AUTOMÁTICO (10 PM - 6:30 AM)'}\n` +
            `• Ahora mismo: ${esHorarioDeBot() ? 'RESPONDIENDO' : 'APAGADO'}\n` +
            `• ¿Dentro del horario? ${enHorarioAutomatico() ? 'sí' : 'no'}\n` +
            `• WhatsApp: ${conectado ? 'conectado' : 'desconectado'}\n` +
            `• Chats pausados: ${Object.keys(chatsPausados).length}`
        );
    }
    if (comando.startsWith('!db ')) {
        return responder(await dbVentana.comando(comando));
    }
    if (comando === '!admin' || comando === '!help') {
        return responder(
            `🛠️ *MENÚ DE COMANDOS DE ADMINISTRACIÓN*\n\n` +
            `🤖 *BOT (automático 10 PM - 6:30 AM)*\n` +
            `• *!bot on* : Lo activas a mano (24/7 + Neon habilitado).\n` +
            `• *!bot off* : Vuelve al horario automático (fuera de horario, apagado).\n` +
            `• *!bot status* : Ver si está respondiendo.\n\n` +
            `• *!unpause* : Reactiva el bot (escríbelo DENTRO del chat del cliente).\n` +
            `• *!unpause all* : Reactiva el bot en TODOS los chats.\n\n` +
            `🗄️ *BASE DE DATOS (Neon)*\n` +
            `• *!db on* : Habilita Neon ya (hasta que pongas !db auto).\n` +
            `• *!db auto* : Neon vuelve a su horario (22:00-06:30).\n` +
            `• *!db off* : Fuerza Neon apagado.\n` +
            `• *!db flush* : Guarda ahora los cambios pendientes.\n` +
            `• *!db status* : Ver estado de la base de datos.`
        );
    }
    if (comando === '!unpause' || comando === '!despausar') {
        if (chatId === 'panel' || esChatPropio(sock, chatId)) {
            return responder('⚙️ *ADMIN:* Escribe !unpause dentro del chat del cliente, o usa !unpause all.');
        }
        if (chatsPausados[chatId]) {
            delete chatsPausados[chatId];
            guardarPausas();
            return responder(`⚙️ *ADMIN:* Bot reactivado para el chat de +${numeroReal}.`);
        }
        return responder(`⚙️ *ADMIN:* El chat de +${numeroReal} no estaba pausado.`);
    }
    if (comando === '!unpause all' || comando === '!despausar todo') {
        chatsPausados = {};
        guardarPausas();
        return responder('⚙️ *ADMIN:* Se reactivó el bot en TODOS los chats pausados.');
    }
}

// =========================================================================
// 8. MENSAJES ENTRANTES
// =========================================================================
const normalizar = typeof normalizeMessageContent === 'function' ? normalizeMessageContent : (m) => m;

async function procesarMensaje(sock, msg) {
    if (!msg.message) return;

    const idRemitente = msg.key.remoteJid;
    if (
        !idRemitente ||
        idRemitente.endsWith('@g.us') ||
        idRemitente.endsWith('@broadcast') ||
        idRemitente.endsWith('@newsletter')
    ) return;

    if (msg.key.id && enviados.has(msg.key.id)) return;   // lo envió el propio bot

    // Quita el envoltorio (mensajes temporales, ver una vez...) y los mensajes técnicos de WhatsApp
    const contenido = normalizar(msg.message) || {};
    const tipos = Object.keys(contenido).filter((k) => !TIPOS_TECNICOS.includes(k));
    if (!tipos.length) return;
    const esTexto = tipos[0] === 'conversation' || tipos[0] === 'extendedTextMessage';
    const userMessage = (contenido.conversation || contenido.extendedTextMessage?.text || '').trim();

    const esMensajeMio = msg.key.fromMe;

    // Ignora mensajes viejos que WhatsApp reenvía al reconectar (si no, pausarían chats por error)
    const ts = aNumero(msg.messageTimestamp);
    const edadSeg = ts ? (Date.now() / 1000 - ts) : 0;
    if (esMensajeMio && edadSeg > 90) return;
    if (!esMensajeMio && edadSeg > 900) return;

    // Número real (si el chat viene como LID, WhatsApp manda el número en remoteJidAlt)
    const numeroReal = soloNumero(msg.key.remoteJidAlt || idRemitente);
    const mensajeLower = userMessage.toLowerCase();
    const esComandoAdmin = COMANDOS_ADMIN.includes(mensajeLower);

    // ---- Mensajes enviados desde TU WhatsApp ----
    if (esMensajeMio) {
        if (esComandoAdmin) {
            await ejecutarComando(sock, mensajeLower, idRemitente, numeroReal, miChat(sock));
            return;
        }
        if (esChatPropio(sock, idRemitente)) return;

        chatsPausados[idRemitente] = Date.now() + (2 * 60 * 60 * 1000);
        guardarPausas();
        console.log(`👤 Intervención humana en +${numeroReal}. Bot silenciado por 2 horas.`);
        return;
    }

    // ---- Mensajes de otras personas ----
    if (esChatPropio(sock, idRemitente)) return;

    if (esComandoAdmin) {
        if (NUMEROS_ADMIN.includes(numeroReal)) {
            await ejecutarComando(sock, mensajeLower, idRemitente, numeroReal, idRemitente);
        } else {
            console.log(`🚫 Comando "${mensajeLower}" ignorado: no es admin | remoteJid: ${idRemitente} | remoteJidAlt: ${msg.key.remoteJidAlt || 'no viene'} | número detectado: ${numeroReal}`);
        }
        return;
    }

    if (estaChatPausado(idRemitente)) return;
    if (!esHorarioDeBot()) return;

    // Anti-spam: más de 4 mensajes en 10 segundos pausa el chat 5 minutos
    const ahora = Date.now();
    const recientes = (registroSpam[idRemitente] || []).filter((t) => ahora - t < 10000);
    recientes.push(ahora);
    registroSpam[idRemitente] = recientes;
    if (recientes.length > 4) {
        chatsPausados[idRemitente] = ahora + (5 * 60 * 1000);
        guardarPausas();
        registrarAlerta(`Anti-spam: se pausó el chat de +${numeroReal}`);
        await enviar(sock, miChat(sock), { text: `⚠️ *ALERTA ANTI-SPAM:* Se pausó el chat de +${numeroReal}.` });
        return;
    }

    if (!esTexto) {
        await enviar(sock, idRemitente, { text: '¡Hola! Por el momento solo puedo leer mensajes en texto. ¿En qué te puedo ayudar?' }, { quoted: msg });
        return;
    }
    if (!userMessage) return;

    agregarMensajeAHistorial(idRemitente, 'user', userMessage);
    console.log(`[Mensaje Recibido] De: +${numeroReal} | Texto: "${userMessage}"`);

    try { await sock.sendPresenceUpdate('composing', idRemitente); } catch (e) {}

    let replyText;
    try {
        replyText = await responderConGemini(historialesChats[idRemitente] || []);
    } catch (error) {
        console.error('❌ Gemini falló:', error?.status || '', error?.message || error);
        registrarAlerta(`Gemini falló (${error?.status || 'sin código'}) con +${numeroReal}: ${error?.message || error}`);
        await enviar(sock, idRemitente, { text: MENSAJE_ERROR }, { quoted: msg });
        return;
    }
    if (!replyText) {
        registrarAlerta(`Gemini devolvió una respuesta vacía para +${numeroReal}`);
        await enviar(sock, idRemitente, { text: MENSAJE_ERROR }, { quoted: msg });
        return;
    }

    if (replyText.includes('[TRANSFERIR_HUMANO]')) {
        const match = replyText.match(/\[TRANSFERIR_HUMANO\]\s*RESUMEN:\s*([\s\S]*?)\s*PREGUNTA:\s*([\s\S]*?)\s*\[\/TRANSFERIR_HUMANO\]/i);
        const resumen = match ? match[1].trim() : 'El cliente solicitó atención directa.';
        const pregunta = match ? match[2].trim() : userMessage;

        registrarAlerta(`Asesor humano: +${numeroReal} — ${resumen} | ${pregunta}`);
        await enviar(sock, miChat(sock), {
            text: `🚨 *SOLICITUD DE ASESOR HUMANO*\n\n📱 *Cliente:* +${numeroReal}\n📋 *Resumen:* ${resumen}\n❓ *Consulta:* ${pregunta}`
        });

        replyText = replyText.replace(/\[TRANSFERIR_HUMANO\][\s\S]*?\[\/TRANSFERIR_HUMANO\]/gi, '').trim()
            || 'Claro que sí, con gusto. Le acabo de notificar a uno de nuestros asesores para que tome tu caso personalmente en breve.';

        chatsPausados[idRemitente] = Date.now() + (4 * 60 * 60 * 1000);
        guardarPausas();
    }

    agregarMensajeAHistorial(idRemitente, 'model', replyText);
    await enviar(sock, idRemitente, { text: replyText }, { quoted: msg });
}

// =========================================================================
// 9. CONEXIÓN A WHATSAPP (BAILEYS)
// =========================================================================
function programarReconexion(ms) {
    if (reconexionProgramada || apagando) return;
    reconexionProgramada = true;
    console.log(`🔁 Reintentando en ${Math.round(ms / 1000)}s...`);
    setTimeout(() => {
        reconexionProgramada = false;
        iniciarBot().catch((e) => {
            console.error('❌ Error al iniciar el bot:', e?.message || e);
            intentos++;
            programarReconexion(Math.min(5000 * 2 ** intentos, 60000));
        });
    }, ms);
}

function cerrarSocketAnterior() {
    if (!sockActual) return;
    try { sockActual.ev.removeAllListeners(); } catch (e) {}
    try { sockActual.end(undefined); } catch (e) {}
    sockActual = null;
}

async function iniciarBot() {
    console.log('🚀 Iniciando motor de Baileys...');
    cerrarSocketAnterior();

    // La sesión se carga UNA vez (en reconexiones se reutiliza la memoria, no se vuelve a leer Neon)
    authActual = await usePostgresAuthState(pool, 'avi');
    const { state, saveCreds } = authActual;

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 Versión WhatsApp Web: ${version.join('.')} (última: ${isLatest})`);

    const logger = pino({ level: LOG_LEVEL });

    const sock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async (key) => enviados.get(key.id) || undefined,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: true,
        markOnlineOnConnect: true
    });
    sockActual = sock;

    sock.ev.on('creds.update', saveCreds);

    let codigoSolicitado = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && PAIRING_NUMBER && !state.creds.registered && !codigoSolicitado) {
            codigoSolicitado = true;
            try {
                const codigo = await sock.requestPairingCode(PAIRING_NUMBER);
                latestPairingCode = codigo.match(/.{1,4}/g).join('-');
                console.log(`🔑 CÓDIGO DE VINCULACIÓN: ${latestPairingCode}  (también en /qr)`);
            } catch (e) {
                codigoSolicitado = false;
                console.error('❌ No se pudo generar el código de vinculación:', e?.message || e);
            }
        }

        if (qr) {
            latestQR = qr;
            console.log(`📲 QR listo: ábrelo en ${SELF_URL || 'https://TU-SERVICIO.onrender.com'}/qr?key=${QR_TOKEN}`);
        }

        if (connection === 'close') {
            conectado = false;
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            console.log(`⚠️ Conexión cerrada | código: ${statusCode ?? 'sin código'} | motivo: ${error?.message || error || 'desconocido'}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Sesión cerrada desde el celular. Limpiando sesión en la base de datos...');
                registrarAlerta('WhatsApp cerró la sesión (dispositivo desvinculado). Hay que vincular de nuevo en /qr');
                try { await authActual.clearAll(); } catch (e) {
                    console.error('No se pudo limpiar la sesión:', e?.message || e);
                }
                latestQR = '';
                latestPairingCode = '';
                intentos = 0;
                return programarReconexion(3000);
            }

            if (statusCode === DisconnectReason.connectionReplaced) {
                // Otra instancia tomó la sesión: NO guardar nuestras claves (pisarían las suyas)
                console.error('⚠️ Otra conexión tomó la sesión. Cerrando esta instancia para no pelear por ella.');
                descartarPendiente();
                return apagar(1);
            }

            if (statusCode === DisconnectReason.restartRequired) {
                return programarReconexion(1000);   // normal justo después de vincular
            }

            intentos++;
            return programarReconexion(Math.min(5000 * 2 ** (intentos - 1), 60000));
        }

        if (connection === 'open') {
            conectado = true;
            latestQR = '';
            latestPairingCode = '';
            intentos = 0;
            console.log(`✅ ¡Avi en línea! Cuenta: ${sock.user?.id || '?'} | LID: ${sock.user?.lid || '?'} | Admin → ${miChat(sock)}`);
        }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            const jid = msg.key?.remoteJid;
            if (!jid) continue;
            enCola(jid, () => procesarMensaje(sock, msg))
                .catch((error) => console.error('❌ Error al procesar mensaje:', error?.message || error));
        }
    });
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));

// =========================================================================
// 10. ARRANQUE Y APAGADO ORDENADO
// =========================================================================
async function main() {
    if (!GEMINI_API_KEY) console.error('⚠️ GEMINI_API_KEY no está definida: Avi no podrá responder. Agrégala en Environment.');
    else console.log(`🤖 Gemini directo activo (modelo: ${GEMINI_MODEL}).`);

    pool = crearPool();
    // 1) Habilita Neon, programa los guardados y el apagado nocturno/diurno.
    //    Mientras WhatsApp no esté vinculado, mantiene Neon habilitado.
    await dbVentana.arrancar(pool, {
        forzarSi: () => Boolean(authActual && !authActual.registrado())
    });
    // 2) Espera a que la instancia vieja suelte la sesión
    lockClient = await adquirirBloqueo(pool);
    // 3) Carga pausas e historiales a memoria
    await cargarMemoria();
    // 4) Conecta WhatsApp
    await iniciarBot();
}

async function apagar(codigo) {
    // codigo === 1 => salida "con error" para que Render reinicie el servicio
    if (apagando) return;
    apagando = true;
    console.log('🛑 Apagando de forma ordenada...');
    try { sockActual?.end(undefined); } catch (e) {}
    // Guarda en Neon todo lo pendiente (claves, pausas, historiales)
    try { await dbVentana.alApagar(); } catch (e) {
        console.error('No se pudo guardar al apagar:', e?.message || e);
    }
    try { await lockClient?.liberar(); } catch (e) {}
    try { await pool?.end(); } catch (e) {}
    process.exit(codigo === 1 ? 1 : 0);
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);

main().catch((e) => {
    console.error('❌ Error fatal al iniciar:', e?.message || e);
    process.exit(1);
});