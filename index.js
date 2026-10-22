const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const http = require('http');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const PROMPT_SISTEMA_AVI = require('./prompt-avi');
const {
    crearPool,
    adquirirBloqueo,
    usePostgresAuthState,
    kvGet,
    kvSet,
    descartarPendiente
} = require('./auth-postgres');
// NUEVO: controla cuándo Neon está habilitado y cada cuánto se guardan los cambios
const dbVentana = require('./db-ventana');

// =========================================================================
// 0. CONFIGURACIÓN (variables de entorno opcionales en Render)
// =========================================================================
const PORT = process.env.PORT || 10000;
const QR_TOKEN = process.env.QR_TOKEN || '';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/\D/g, '');

const API_URL = 'https://avior-ai.onrender.com/api/chat-wsp';

// Llamada DIRECTA a Gemini (sin pasar por avior-ai)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

let clienteGemini = null;
async function obtenerGemini() {
    if (!GEMINI_API_KEY) return null;
    if (!clienteGemini) {
        try {
            const { GoogleGenAI } = await import('@google/genai');
            clienteGemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        } catch (e) {
            console.error('❌ No se pudo cargar @google/genai (¿falta npm install @google/genai?). Usando la API:', e?.message || e);
            return null;
        }
    }
    return clienteGemini;
}

async function generarConGemini(gemini, historial) {
    const contents = historial.map((m) => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.content ?? '') }]
    }));
    while (contents.length && contents[0].role !== 'user') contents.shift();

    const intentosMax = 3;
    for (let i = 0; i < intentosMax; i++) {
        try {
            const respuesta = await gemini.models.generateContent({
                model: GEMINI_MODEL,
                contents,
                config: { systemInstruction: PROMPT_SISTEMA_AVI }
            });
            return String(respuesta.text || '').trim();
        } catch (error) {
            const reintentable = error?.status === 503 || error?.status === 429;
            if (reintentable && i < intentosMax - 1) {
                console.warn(`[Gemini ${error.status}] reintentando (${i + 1}/${intentosMax})...`);
                await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
                continue;
            }
            throw error;
        }
    }
}

// Números externos autorizados para ejecutar comandos admin (opcional).
// Solo dígitos con código de país. Ej: ['51922501122']
// Mejor opción: define ADMIN_NUMBER en Render con tu OTRO número (solo dígitos, ej: 51922501122).
// Desde ese número le escribes los comandos al bot, y ahí te llegan respuestas y alertas.
// (El chat contigo mismo falla seguido con "Esperando el mensaje".)
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const NUMEROS_ADMIN = ADMIN_NUMBER ? [ADMIN_NUMBER] : [];

// 📌 TU CHAT PERSONAL
const MI_CHAT_PERSONAL = '51987355501@s.whatsapp.net';

// Estado en memoria
let chatsPausados = {};
let historialesChats = {};
const registroSpam = {};
let ignorarHorario = false;

let latestQR = '';
let latestPairingCode = '';
let conectado = false;

let pool = null;
let lockClient = null;
let authActual = null;
let apagando = false;

const mensajesDelBot = new Set();
const mensajesEnviados = new Map();

const COMANDOS_ADMIN = [
    '!unpause', '!despausar',
    '!unpause all', '!despausar todo', '!admin', '!help',
    // Control del bot (horario automático 22:00-06:30)
    '!bot on', '!bot off', '!bot auto', '!bot status',
    // NUEVO: control de la base de datos Neon
    '!db on', '!db off', '!db auto', '!db status', '!db flush'
];

// ---- Helpers de identidad (WhatsApp ahora usa LID además del número) ----
function aNumero(n) {
    if (!n) return 0;
    if (typeof n === 'number') return n;
    if (typeof n === 'object') return typeof n.toNumber === 'function' ? n.toNumber() : (n.low || 0);
    return Number(n) || 0;
}

function soloNumero(jid) {
    return String(jid || '').split('@')[0].split(':')[0];
}

// JIDs que representan tu propio chat ("Tú" / mensajes a ti mismo)
function jidsPropios(sock) {
    const lista = [MI_CHAT_PERSONAL];
    if (sock.user?.id) lista.push(jidNormalizedUser(sock.user.id));
    if (sock.user?.lid) lista.push(jidNormalizedUser(sock.user.lid));
    return lista;
}

function esChatPropio(sock, jid) {
    if (!sock) return false;
    return jidsPropios(sock).includes(jid);
}

// A dónde mandar las notificaciones y respuestas de admin (tu chat contigo mismo).
// Se usa el LID si existe: enviar al número viejo es lo que dejaba "Esperando este mensaje".
function miChat(sock) {
    if (ADMIN_NUMBER) return `${ADMIN_NUMBER}@s.whatsapp.net`;
    return sock.user?.lid ? jidNormalizedUser(sock.user.lid) : MI_CHAT_PERSONAL;
}

// Alertas recientes (se muestran en el panel web /admin; se pierden al reiniciar)
const alertas = [];
function registrarAlerta(texto) {
    const hora = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
    alertas.unshift(`${hora} — ${texto}`);
    if (alertas.length > 20) alertas.pop();
}
function esc(t) {
    return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// =========================================================================
// 1. SERVIDOR HTTP (health check + visor del QR protegido)
// =========================================================================
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    // Panel de administración web (no depende de WhatsApp para responder)
    if (url.pathname === '/admin') {
        if (!QR_TOKEN || url.searchParams.get('key') !== QR_TOKEN) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Acceso denegado. Define QR_TOKEN en Render y entra con /admin?key=TU_CLAVE');
        }

        const cmd = (url.searchParams.get('cmd') || '').toLowerCase().trim();
        let salida = '';
        if (cmd) {
            if (!COMANDOS_ADMIN.includes(cmd) || cmd === '!admin' || cmd === '!help') {
                salida = 'Comando no permitido.';
            } else {
                const partes = [];
                try {
                    await ejecutarComando(null, cmd, 'panel', 'panel', null, (t) => partes.push(t));
                    salida = partes.join('\n\n') || 'Hecho.';
                } catch (e) {
                    salida = 'Error: ' + (e?.message || e);
                }
            }
        }

        const k = encodeURIComponent(QR_TOKEN);
        const botones = ['!bot status', '!bot on', '!bot off', '!unpause all', '!db status', '!db flush', '!db on', '!db auto', '!db off']
            .map((c) => `<a class="b" href="/admin?key=${k}&cmd=${encodeURIComponent(c)}">${esc(c)}</a>`).join('');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avi - Panel</title>
<style>
body{margin:0;padding:20px;background:#111;color:#fff;font-family:sans-serif}
h1{font-size:20px}.b{display:inline-block;margin:4px;padding:12px 16px;background:#1f6feb;color:#fff;border-radius:8px;text-decoration:none;font-size:15px}
pre{background:#1b1b1b;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word}.m{color:#aaa;font-size:14px}
</style></head><body>
<h1>🤖 Panel de Avi</h1>
<p class="m">WhatsApp: <b>${conectado ? 'conectado ✅' : 'desconectado ❌'}</b> · Modo: <b>${ignorarHorario ? 'activado a mano (24/7)' : 'automático (10 PM - 6:30 AM)'}</b> · Respondiendo ahora: <b>${esHorarioDeBot() ? 'sí' : 'no'}</b> · Chats pausados: <b>${Object.keys(chatsPausados).length}</b></p>
<div>${botones}</div>
${salida ? `<h3>Resultado</h3><pre>${esc(salida)}</pre>` : ''}
<h3>Alertas recientes</h3>
<pre>${alertas.length ? esc(alertas.join('\n')) : 'Sin alertas desde el último reinicio.'}</pre>
</body></html>`);
    }

    if (url.pathname === '/qr') {
        if (QR_TOKEN && url.searchParams.get('key') !== QR_TOKEN) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Acceso denegado');
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

        if (latestPairingCode) {
            return res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Avi WhatsApp - Código de vinculación</title>
<meta http-equiv="refresh" content="20"></head>
<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:0 20px">
<h1>Código de vinculación para Avi</h1>
<div style="font-size:56px;letter-spacing:8px;font-weight:bold;background:#fff;color:#111;padding:20px 30px;border-radius:12px">${latestPairingCode}</div>
<p style="margin-top:24px;color:#aaa;max-width:420px">En WhatsApp: Dispositivos vinculados → Vincular dispositivo → <b>Vincular con el número de teléfono</b> → escribe este código.</p>
</body></html>`);
        }

        if (latestQR) {
            const dataUrl = await QRCode.toDataURL(latestQR, { width: 300, margin: 1 });
            return res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Avi WhatsApp - Escanear QR</title>
<meta http-equiv="refresh" content="15"></head>
<body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif">
<h1>Escanea el QR para Avi (Scroll Studios)</h1>
<img src="${dataUrl}" alt="QR WhatsApp" style="border:10px solid #fff;border-radius:10px;background:#fff"/>
<p style="margin-top:20px;color:#aaa;text-align:center">La página se actualiza sola cada 15 segundos.</p>
</body></html>`);
        }

        const estado = conectado
            ? '¡Avi ya está vinculado y en línea!'
            : 'Esperando el código QR... recarga en unos segundos.';
        return res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Avi WhatsApp Bot</title>
<meta http-equiv="refresh" content="10"></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif">
<h1>${estado}</h1></body></html>`);
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Avi WhatsApp Bot - Service Active | WhatsApp: ${conectado ? 'conectado' : 'desconectado'}`);
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP activo en el puerto ${PORT}`);
});

// Auto-ping para que Render free no duerma el servicio (no toca la base de datos)
if (SELF_URL) {
    setInterval(() => {
        axios.get(SELF_URL, { timeout: 15000 }).catch(() => {});
    }, 10 * 60 * 1000);
}

// =========================================================================
// 2. PERSISTENCIA (PAUSAS E HISTORIAL)
//    kvSet ahora solo escribe en memoria; db-ventana.js lo guarda en lote.
// =========================================================================
async function cargarMemoria() {
    try {
        chatsPausados = (await kvGet(pool, 'pausas')) || {};
        historialesChats = (await kvGet(pool, 'historiales')) || {};
        console.log('📦 Pausas e historiales cargados desde Postgres.');
    } catch (e) {
        console.error('Error al cargar memoria:', e.message);
    }
}

function guardarPausas() {
    kvSet(pool, 'pausas', chatsPausados)
        .catch((e) => console.error('Error al guardar pausas:', e.message));
}

function guardarHistoriales() {
    kvSet(pool, 'historiales', historialesChats)
        .catch((e) => console.error('Error al guardar historiales:', e.message));
}

function agregarMensajeAHistorial(userId, rol, texto) {
    if (!historialesChats[userId]) historialesChats[userId] = [];
    historialesChats[userId].push({ role: rol, content: texto });
    if (historialesChats[userId].length > 6) {
        historialesChats[userId] = historialesChats[userId].slice(-6);
    }
    guardarHistoriales();
}

// =========================================================================
// 3. HORARIO DEL BOT (PERÚ - UTC-5): automático SOLO de 10:00 PM a 6:30 AM
//    Fuera de ese horario el bot está apagado, salvo que lo actives con !bot on
// =========================================================================
const BOT_INICIO_MIN = 22 * 60;       // 10:00 PM
const BOT_FIN_MIN = 6 * 60 + 30;      // 6:30 AM

function esHorarioDeBot() {
    if (ignorarHorario) return true;   // activado a mano con !bot on

    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Lima',
        hourCycle: 'h23',
        hour: 'numeric',
        minute: 'numeric'
    }).formatToParts(new Date());

    let hora = 0;
    let minutos = 0;
    for (const part of partes) {
        if (part.type === 'hour') hora = parseInt(part.value, 10) % 24;
        if (part.type === 'minute') minutos = parseInt(part.value, 10);
    }
    const minutosTotales = hora * 60 + minutos;

    // Cruza la medianoche: 22:00 -> 24:00 y 00:00 -> 06:30
    return minutosTotales >= BOT_INICIO_MIN || minutosTotales < BOT_FIN_MIN;
}

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
// 4. UTILIDADES DE ENVÍO Y TEXTO
// =========================================================================
async function enviar(sock, jid, contenido, opciones) {
    const enviado = await sock.sendMessage(jid, contenido, opciones);
    const id = enviado?.key?.id;
    if (id) {
        mensajesDelBot.add(id);
        if (mensajesDelBot.size > 500) {
            mensajesDelBot.delete(mensajesDelBot.values().next().value);
        }
        if (enviado.message) {
            mensajesEnviados.set(id, enviado.message);
            if (mensajesEnviados.size > 1000) {
                mensajesEnviados.delete(mensajesEnviados.keys().next().value);
            }
        }
    }
    return enviado;
}

function extraerTexto(msg) {
    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
    ).trim();
}

// =========================================================================
// 5. COMANDOS ADMIN (siempre responden a tu chat personal, nunca al cliente)
// =========================================================================
async function ejecutarComando(sock, comando, chatId, numeroReal, destino, salida) {
    // Si viene 'salida' (panel web) no se manda nada por WhatsApp
    const responder = salida ? (texto) => salida(texto) : (texto) => enviar(sock, destino || miChat(sock), { text: texto });

    // Control del bot: !bot on = lo activas a mano (24/7, y Neon habilitado)
    //                  !bot off / !bot auto = vuelve al horario automático 22:00-06:30
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
        const dentro = (() => { const o = ignorarHorario; ignorarHorario = false; const r = esHorarioDeBot(); ignorarHorario = o; return r; })();
        return responder(`🤖 *BOT:* ${ignorarHorario ? 'ACTIVADO A MANO (24/7)' : 'AUTOMÁTICO (10 PM - 6:30 AM)'}\n• Ahora mismo: ${esHorarioDeBot() ? 'RESPONDIENDO' : 'APAGADO'}\n• ¿Dentro del horario? ${dentro ? 'sí' : 'no'}`);
    }

    // Comandos de la base de datos Neon
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
// 6. MANEJADOR DE MENSAJES
// =========================================================================
async function procesarMensaje(sock, msg) {
    if (!msg.message) return;

    const idRemitente = msg.key.remoteJid;
    if (
        !idRemitente ||
        idRemitente.endsWith('@g.us') ||
        idRemitente.endsWith('@broadcast') ||
        idRemitente.endsWith('@newsletter')
    ) return;

    if (msg.key.id && mensajesDelBot.has(msg.key.id)) return;

    const tiposTecnicos = [
        'protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage',
        'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage'
    ];
    const tiposReales = Object.keys(msg.message).filter((k) => !tiposTecnicos.includes(k));
    if (tiposReales.length === 0) return;

    const esMensajeMio = msg.key.fromMe;

    // Ignora mensajes viejos que WhatsApp reenvía al reconectar (si no, pausarían chats por error)
    const ts = aNumero(msg.messageTimestamp);
    const edadSeg = ts ? (Date.now() / 1000 - ts) : 0;
    if (esMensajeMio && edadSeg > 90) return;     // tus mensajes: solo los recientes
    if (!esMensajeMio && edadSeg > 900) return;   // clientes: hasta 15 min de antigüedad

    // Número real (si el chat viene como LID, WhatsApp manda el número en remoteJidAlt)
    const numeroReal = soloNumero(msg.key.remoteJidAlt || idRemitente);
    const userMessage = extraerTexto(msg);
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

    // Anti-Spam
    const ahora = Date.now();
    if (!registroSpam[idRemitente]) registroSpam[idRemitente] = [];
    registroSpam[idRemitente] = registroSpam[idRemitente].filter(ts => ahora - ts < 10000);
    registroSpam[idRemitente].push(ahora);

    if (registroSpam[idRemitente].length > 4) {
        chatsPausados[idRemitente] = ahora + (5 * 60 * 1000);
        guardarPausas();
        registrarAlerta(`Anti-spam: se pausó el chat de +${numeroReal}`);
        await enviar(sock, miChat(sock), { text: `⚠️ *ALERTA ANTI-SPAM:* Se pausó el chat de +${numeroReal}.` });
        return;
    }

    const tipoMsg = Object.keys(msg.message)[0];
    if (tipoMsg !== 'conversation' && tipoMsg !== 'extendedTextMessage') {
        await enviar(sock, idRemitente, { text: '¡Hola! Por el momento solo puedo leer mensajes en texto. ¿En qué te puedo ayudar?' }, { quoted: msg });
        return;
    }

    if (!userMessage) return;

    agregarMensajeAHistorial(idRemitente, 'user', userMessage);
    console.log(`[Mensaje Recibido] De: +${numeroReal} | Texto: "${userMessage}"`);

    try { await sock.sendPresenceUpdate('composing', idRemitente); } catch (e) {}

    let replyText;

    const gemini = await obtenerGemini();
    if (gemini) {
        try {
            replyText = await generarConGemini(gemini, historialesChats[idRemitente] || []);
            if (!replyText) replyText = 'Sin respuesta válida del servidor.';
        } catch (error) {
            console.error('--- ERROR EN GEMINI DIRECTO ---', error?.status || '', error?.message || error);
            await enviar(sock, idRemitente, { text: 'Hola, ocurrió un inconveniente temporal en el servidor. Por favor intenta de nuevo en un momento.' }, { quoted: msg });
            return;
        }
    } else {
        const response = await axios.post(
            API_URL,
            {
                systemInstruction: PROMPT_SISTEMA_AVI,
                message: userMessage,
                prompt: userMessage,
                userId: idRemitente,
                history: historialesChats[idRemitente] || [],
                maxTokens: 150
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 120000,
                validateStatus: (status) => status >= 200 && status < 600
            }
        );

        if (response.status !== 200) {
            console.log('--- ERROR HTTP DETECTADO EN API ---', response.status);
            try {
                const cuerpo = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                console.log('Detalle del error de la API:', String(cuerpo).slice(0, 800));
                const h = response.headers || {};
                console.log('Cabeceras de la API:', JSON.stringify({
                    server: h['server'],
                    poweredBy: h['x-powered-by'],
                    retryAfter: h['retry-after'],
                    renderOrigin: h['x-render-origin-server'],
                    rndrId: h['rndr-id'],
                    cfRay: h['cf-ray'],
                    contentType: h['content-type']
                }));
                console.log('Tamaño del prompt enviado (caracteres):', String(PROMPT_SISTEMA_AVI).length);
            } catch (e) {}
            await enviar(sock, idRemitente, { text: 'Hola, ocurrió un inconveniente temporal en el servidor. Por favor intenta de nuevo en un momento.' }, { quoted: msg });
            return;
        }

        replyText = String(
            response.data.reply || response.data.message || response.data.response || 'Sin respuesta válida del servidor.'
        );
    }

    if (replyText.includes('[TRANSFERIR_HUMANO]')) {
        const regex = /\[TRANSFERIR_HUMANO\]\s*RESUMEN:\s*([\s\S]*?)\s*PREGUNTA:\s*([\s\S]*?)\s*\[\/TRANSFERIR_HUMANO\]/i;
        const match = replyText.match(regex);

        let resumen = 'El cliente solicitó atención directa.';
        let pregunta = userMessage;
        if (match) {
            resumen = match[1].trim();
            pregunta = match[2].trim();
        }

        registrarAlerta(`Asesor humano: +${numeroReal} — ${resumen} | ${pregunta}`);
        await enviar(sock, miChat(sock), {
            text: `🚨 *SOLICITUD DE ASESOR HUMANO*\n\n📱 *Cliente:* +${numeroReal}\n📋 *Resumen:* ${resumen}\n❓ *Consulta:* ${pregunta}`
        });

        replyText = replyText.replace(/\[TRANSFERIR_HUMANO\][\s\S]*?\[\/TRANSFERIR_HUMANO\]/gi, '').trim();
        if (!replyText) {
            replyText = 'Claro que sí, con gusto. Le acabo de notificar a uno de nuestros asesores para que tome tu caso personalmente en breve.';
        }

        chatsPausados[idRemitente] = Date.now() + (4 * 60 * 60 * 1000);
        guardarPausas();
    }

    agregarMensajeAHistorial(idRemitente, 'model', replyText);
    await enviar(sock, idRemitente, { text: replyText }, { quoted: msg });
}

// =========================================================================
// 7. CONEXIÓN A WHATSAPP (BAILEYS)
// =========================================================================
let sockActual = null;
let reconexionProgramada = false;
let intentos = 0;

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

    // Carga la sesión UNA vez (en reconexiones reutiliza la memoria, no vuelve a leer Neon)
    authActual = await usePostgresAuthState(pool, 'avi');
    const { state, saveCreds } = authActual;

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 Versión WhatsApp Web: ${version.join('.')} (última: ${isLatest})`);

    const logger = pino({ level: LOG_LEVEL });

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage: async (key) => mensajesEnviados.get(key.id),
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
                console.log('\n==============================================');
                console.log(`🔑 CÓDIGO DE VINCULACIÓN: ${latestPairingCode}`);
                console.log('   WhatsApp → Dispositivos vinculados → Vincular dispositivo');
                console.log('   → "Vincular con el número de teléfono" → escribe el código');
                console.log('==============================================\n');
            } catch (e) {
                codigoSolicitado = false;
                console.error('❌ No se pudo generar el código de vinculación:', e?.message || e);
            }
        }

        if (qr) {
            latestQR = qr;
            console.log('\n--- CÓDIGO QR RECIBIDO ---');
            console.log(`🔗 Ábrelo en: ${SELF_URL || 'https://TU-SERVICIO.onrender.com'}/qr${QR_TOKEN ? '?key=TU_CLAVE' : ''}`);
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            conectado = false;
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;

            console.log(`⚠️ Conexión cerrada | código: ${statusCode ?? 'sin código'} | motivo: ${error?.message || error || 'desconocido'}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Sesión cerrada desde el celular. Limpiando sesión en la base de datos...');
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
                return programarReconexion(1000);
            }

            intentos++;
            return programarReconexion(Math.min(5000 * 2 ** (intentos - 1), 60000));
        }

        if (connection === 'open') {
            conectado = true;
            latestQR = '';
            latestPairingCode = '';
            intentos = 0;
            console.log(`\n==============================================`);
            console.log(`✅ ¡Avi en línea! Conectado con éxito a WhatsApp.`);
            console.log(`   Cuenta: ${sock.user?.id || '?'} | LID: ${sock.user?.lid || '?'} | Admin → ${miChat(sock)}`);
            console.log(`==============================================\n`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try {
                await procesarMensaje(sock, msg);
            } catch (error) {
                console.error('====================================');
                console.error('   DETALLE DE ERROR EN MENSAJE   ');
                console.error(error?.message || error);
                console.error('====================================');
            }
        }
    });
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));

// =========================================================================
// 8. ARRANQUE Y APAGADO ORDENADO
// =========================================================================
async function main() {
    pool = crearPool();
    // 1) Habilita Neon, programa los guardados y el apagado nocturno/diurno.
    //    Mientras WhatsApp no esté vinculado, mantiene Neon habilitado.
    await dbVentana.arrancar(pool, {
        forzarSi: () => Boolean(authActual && !authActual.registrado())
    });
    // 2) Espera a que la instancia vieja suelte la sesión (usa Neon solo ahora)
    lockClient = await adquirirBloqueo(pool);
    // 3) Carga pausas e historiales a memoria
    await cargarMemoria();
    if (GEMINI_API_KEY) {
        console.log(`🤖 Modo Gemini DIRECTO activo (modelo: ${GEMINI_MODEL}).`);
    } else {
        console.log('⚠️ GEMINI_API_KEY no está definida en este servicio: se usa la API de avior-ai (da 429). Agrégala en Environment.');
    }
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