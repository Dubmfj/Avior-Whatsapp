const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    makeCacheableSignalKeyStore          // CAMBIO 1: cache de claves Signal (menos lecturas, menos carreras)
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const http = require('http');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const PROMPT_SISTEMA_AVI = require('./prompt-avi');
// CAMBIO 2: módulo nuevo con auth en Postgres, bloqueo de instancia única y almacén clave/valor
const {
    crearPool,
    adquirirBloqueo,
    usePostgresAuthState,
    kvGet,
    kvSet
} = require('./auth-postgres');

// =========================================================================
// 0. CONFIGURACIÓN (variables de entorno opcionales en Render)
// =========================================================================
const PORT = process.env.PORT || 10000;
const QR_TOKEN = process.env.QR_TOKEN || '';          // clave para ver el QR: /qr?key=TU_CLAVE
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';    // pon 'silent' cuando todo ande bien
const SELF_URL = process.env.RENDER_EXTERNAL_URL || ''; // Render lo define solo
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''); // ej: 51987355501 (vincular con código en vez de QR)

// CAMBIO 3: ya no hay SESSION_DIR / PAUSAS_FILE / HISTORIALES_FILE.
// En Render el disco se borra en cada deploy; todo vive en Postgres (DATABASE_URL).

const API_URL = 'https://avior-ai.onrender.com/api/chat-wsp';

// CAMBIO 14: llamada DIRECTA a Gemini (sin pasar por avior-ai).
// El 429 venía del borde de Render/Cloudflare, no de tu API ni de Gemini: la petición
// bot -> URL pública de avior-ai ni siquiera llegaba a Express. Si defines GEMINI_API_KEY
// en este servicio, el bot habla directo con Gemini; si no, usa la API de antes.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash'; // el mismo que usa tu server.js

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

// El historial ya incluye el último mensaje del cliente. Gemini recibe todo el hilo,
// así Avi recuerda la conversación (la API anterior solo mandaba el último mensaje).
async function generarConGemini(gemini, historial) {
    const contents = historial.map((m) => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String(m.content ?? '') }]
    }));
    while (contents.length && contents[0].role !== 'user') contents.shift(); // debe empezar con el cliente

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

// Números externos autorizados para ejecutar comandos admin (opcional)
const NUMEROS_ADMIN = [];

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

// CAMBIO 4: recursos compartidos de la nueva arquitectura
let pool = null;          // conexión a Postgres
let lockClient = null;    // conexión que mantiene el bloqueo de instancia única
let authActual = null;    // auth state actual (para poder borrarlo en loggedOut)
let apagando = false;     // true mientras Render nos apaga (evita reconectar)

// IDs de mensajes enviados por el propio bot (para no confundirlos con intervención humana)
const mensajesDelBot = new Set();

// CAMBIO 5: copia de los mensajes enviados; Baileys la pide en getMessage para reenviar
// cuando el cliente solicita un reintento (evita parte de los "Esperando el mensaje")
const mensajesEnviados = new Map();

const COMANDOS_ADMIN = [
    '!horario off', '!horario false', '!horario 0',
    '!horario on', '!horario true', '!horario 1',
    '!horario status', '!unpause', '!despausar',
    '!unpause all', '!despausar todo', '!admin', '!help'
];

// =========================================================================
// 1. SERVIDOR HTTP (health check + visor del QR protegido)
// =========================================================================
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

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
            // El QR se genera aquí mismo: no se envía a ningún servicio externo
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

// Auto-ping para que Render free no duerma el servicio (complementa a UptimeRobot)
if (SELF_URL) {
    setInterval(() => {
        axios.get(SELF_URL, { timeout: 15000 }).catch(() => {});
    }, 10 * 60 * 1000);
}

// =========================================================================
// 2. PERSISTENCIA (PAUSAS E HISTORIAL) — CAMBIO 6: ahora en Postgres
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

// (la carga ahora se hace en main(), después de conectar a Postgres)

// =========================================================================
// 3. HORARIOS (PERÚ - UTC-5)
// =========================================================================
function esHorarioDeBot() {
    if (ignorarHorario) return true;

    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Lima',
        hourCycle: 'h23',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric'
    }).formatToParts(new Date());

    let diaSemanaStr = '';
    let hora = 0;
    let minutos = 0;

    for (const part of partes) {
        if (part.type === 'weekday') diaSemanaStr = part.value;
        if (part.type === 'hour') hora = parseInt(part.value, 10) % 24;
        if (part.type === 'minute') minutos = parseInt(part.value, 10);
    }

    const diasMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const diaSemana = diasMap[diaSemanaStr] ?? new Date().getDay();
    const minutosTotales = hora * 60 + minutos;
    const esJuevesOSabado = (diaSemana === 4 || diaSemana === 6);

    // Bloque 1: 11:00 PM a 2:00 PM
    if (minutosTotales >= 23 * 60 || minutosTotales < 14 * 60) return true;

    // Bloque 2: Jueves y Sábados 7:00 PM a 11:00 PM
    if (esJuevesOSabado && minutosTotales >= 19 * 60 && minutosTotales < 23 * 60) return true;

    return false;
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
        // CAMBIO 5 (cont.): guardamos el contenido para getMessage
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
async function ejecutarComando(sock, comando, chatId, numeroReal) {
    const responder = (texto) => enviar(sock, MI_CHAT_PERSONAL, { text: texto });

    if (comando === '!admin' || comando === '!help') {
        return responder(
            `🛠️ *MENÚ DE COMANDOS DE ADMINISTRACIÓN*\n\n` +
            `• *!horario off* : Desactiva el filtro de horario (24/7).\n` +
            `• *!horario on* : Activa el filtro de horario laboral.\n` +
            `• *!horario status* : Ver estado actual del filtro.\n` +
            `• *!unpause* : Reactiva el bot (escríbelo DENTRO del chat del cliente).\n` +
            `• *!unpause all* : Reactiva el bot en TODOS los chats.`
        );
    }

    if (comando === '!unpause' || comando === '!despausar') {
        if (chatId === MI_CHAT_PERSONAL) {
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

    if (['!horario off', '!horario false', '!horario 0'].includes(comando)) {
        ignorarHorario = true;
        return responder('⚙️ *ADMIN:* Modo de prueba activado (filtro de horario DESACTIVADO).');
    }

    if (['!horario on', '!horario true', '!horario 1'].includes(comando)) {
        ignorarHorario = false;
        return responder('⚙️ *ADMIN:* Modo normal activado (filtro de horario ACTIVADO).');
    }

    if (comando === '!horario status') {
        const estado = ignorarHorario ? 'DESACTIVADO (responde 24/7)' : 'ACTIVADO (respeta horario)';
        return responder(`⚙️ *ADMIN:* Estado del filtro de horario: ${estado}`);
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

    // Ignora lo que envió el propio bot
    if (msg.key.id && mensajesDelBot.has(msg.key.id)) return;

    // CAMBIO 12: ignora mensajes técnicos de WhatsApp (sincronización de historial, claves,
    // reacciones). Antes contaban como "intervención humana" y pausaban chats sin motivo.
    const tiposTecnicos = [
        'protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage',
        'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage'
    ];
    const tiposReales = Object.keys(msg.message).filter((k) => !tiposTecnicos.includes(k));
    if (tiposReales.length === 0) return;

    const esMensajeMio = msg.key.fromMe;
    const numeroReal = idRemitente.split('@')[0];
    const userMessage = extraerTexto(msg);
    const mensajeLower = userMessage.toLowerCase();
    const esComandoAdmin = COMANDOS_ADMIN.includes(mensajeLower);

    // ---- Mensajes enviados desde TU WhatsApp ----
    if (esMensajeMio) {
        if (esComandoAdmin) {
            await ejecutarComando(sock, mensajeLower, idRemitente, numeroReal);
            return;
        }
        if (idRemitente === MI_CHAT_PERSONAL) return;

        chatsPausados[idRemitente] = Date.now() + (2 * 60 * 60 * 1000);
        guardarPausas();
        console.log(`👤 Intervención humana en +${numeroReal}. Bot silenciado por 2 horas.`);
        return;
    }

    // ---- Mensajes de otras personas ----
    if (idRemitente === MI_CHAT_PERSONAL) return;

    if (esComandoAdmin) {
        if (NUMEROS_ADMIN.includes(idRemitente)) {
            await ejecutarComando(sock, mensajeLower, idRemitente, numeroReal);
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
        await enviar(sock, MI_CHAT_PERSONAL, { text: `⚠️ *ALERTA ANTI-SPAM:* Se pausó el chat de +${numeroReal}.` });
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
        // CAMBIO 13: muestra el cuerpo del error para saber la causa real (cuota, límite, etc.)
        try {
            const cuerpo = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            console.log('Detalle del error de la API:', String(cuerpo).slice(0, 800));
            // Las cabeceras dicen QUIÉN respondió el error (tu API, Cloudflare/Render u otro)
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
    } // fin del modo "API de avior-ai"

    if (replyText.includes('[TRANSFERIR_HUMANO]')) {
        const regex = /\[TRANSFERIR_HUMANO\]\s*RESUMEN:\s*([\s\S]*?)\s*PREGUNTA:\s*([\s\S]*?)\s*\[\/TRANSFERIR_HUMANO\]/i;
        const match = replyText.match(regex);

        let resumen = 'El cliente solicitó atención directa.';
        let pregunta = userMessage;
        if (match) {
            resumen = match[1].trim();
            pregunta = match[2].trim();
        }

        await enviar(sock, MI_CHAT_PERSONAL, {
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
    // CAMBIO 7: si Render nos está apagando, no reconectar
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

    // CAMBIO 8: las claves y credenciales se leen/escriben en Postgres, no en archivos
    authActual = await usePostgresAuthState(pool, 'avi');
    const { state, saveCreds } = authActual;

    // Pide la versión ACTUAL de WhatsApp Web (versiones viejas = cierre inmediato)
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📡 Versión WhatsApp Web: ${version.join('.')} (última: ${isLatest})`);

    const logger = pino({ level: LOG_LEVEL });

    const sock = makeWASocket({
        version,
        // CAMBIO 1 (cont.): claves envueltas en caché
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        // CAMBIO 5 (cont.): permite reenviar mensajes cuando el cliente pide reintento
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

        // Modo código de vinculación (más cómodo que el QR en Render)
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
                // CAMBIO 9: se borra la sesión de la base de datos (antes: la carpeta)
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
                // CAMBIO 10: otra conexión usa estas mismas claves. Esta instancia se retira
                // (NO reintenta): reconectar patearía a la otra y se pelearían por la sesión.
                // Render la reinicia y, al arrancar, espera hasta que la sesión quede libre.
                console.error('⚠️ Otra conexión tomó la sesión. Cerrando esta instancia para no pelear por ella.');
                return apagar(1);
            }

            if (statusCode === DisconnectReason.restartRequired) {
                // Normal justo después de escanear el QR
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

// Que un error suelto no tumbe el proceso
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));

// =========================================================================
// 8. ARRANQUE Y APAGADO ORDENADO — CAMBIO 11
// =========================================================================
async function main() {
    pool = crearPool();
    // Espera aquí hasta que la instancia vieja de Render suelte la sesión de WhatsApp
    lockClient = await adquirirBloqueo(pool);
    await cargarMemoria();
    if (GEMINI_API_KEY) {
        console.log(`🤖 Modo Gemini DIRECTO activo (modelo: ${GEMINI_MODEL}).`);
    } else {
        console.log('⚠️ GEMINI_API_KEY no está definida en este servicio: se usa la API de avior-ai (da 429). Agrégala en Environment.');
    }
    await iniciarBot();
}

async function apagar(codigo) {
    // codigo === 1 => salida "con error" para que Render reinicie el servicio
    // (las señales SIGTERM/SIGINT llegan aquí como texto, y eso cuenta como salida normal)
    if (apagando) return;
    apagando = true;
    console.log('🛑 Apagando de forma ordenada...');
    try { sockActual?.end(undefined); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500)); // deja terminar escrituras pendientes
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