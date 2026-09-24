const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

// =========================================================================
// 0. HEALTH CHECK HTTP PARA RENDER (EVITA QUE RENDER MATE LA INSTANCIA)
// =========================================================================
const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Avi WhatsApp Bot - Service Active');
});
server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP activo en el puerto ${PORT} (Health Check para Render)`);
});

// Endpoint de la API en Render
const API_URL = 'https://avior-ai.onrender.com/api/chat-wsp';

// Archivos de persistencia local
const PAUSAS_FILE = path.join(__dirname, 'pausas.json');
const HISTORIALES_FILE = path.join(__dirname, 'historiales.json');

// OPCIONAL: Números externos autorizados para ejecutar comandos admin
const NUMEROS_ADMIN = []; 

// 📌 TU CHAT PERSONAL
const MI_CHAT_PERSONAL = '51987355501@c.us';

// Memoria principal
let chatsPausados = {};
let historialesChats = {};

// Control Anti-Spam
const registroSpam = {}; 

// Control de horario (true = ignora horario laboral y responde 24/7)
let ignorarHorario = false;

// =========================================================================
// 1. LIMPIEZA DE ARCHIVOS TEMPORALES DE CHROMIUM / PUPPETEER
// =========================================================================
function limpiarArchivosTemporales() {
    try {
        const sessionPath = path.join(__dirname, 'session-avior');
        if (fs.existsSync(sessionPath)) {
            const cacheFolders = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache'];
            cacheFolders.forEach((folder) => {
                const targetFolder = path.join(sessionPath, folder);
                if (fs.existsSync(targetFolder)) {
                    fs.rmSync(targetFolder, { recursive: true, force: true });
                }
            });
            console.log('🧹 Caché temporal de Chromium limpiada con éxito.');
        }
    } catch (e) {
        console.error('Error al limpiar caché temporal:', e.message);
    }
}

limpiarArchivosTemporales();

// =========================================================================
// 2. GESTIÓN DE PERSISTENCIA (PAUSAS E HISTORIAL)
// =========================================================================
function cargarMemoria() {
    try {
        if (fs.existsSync(PAUSAS_FILE)) {
            chatsPausados = JSON.parse(fs.readFileSync(PAUSAS_FILE, 'utf8')) || {};
            console.log('📦 Pausas cargadas desde disco.');
        }
        if (fs.existsSync(HISTORIALES_FILE)) {
            historialesChats = JSON.parse(fs.readFileSync(HISTORIALES_FILE, 'utf8')) || {};
            console.log('📚 Historiales cargados desde disco.');
        }
    } catch (e) {
        console.error('Error al cargar memoria:', e.message);
    }
}

function guardarPausas() {
    try {
        fs.writeFileSync(PAUSAS_FILE, JSON.stringify(chatsPausados, null, 2), 'utf8');
    } catch (e) {
        console.error('Error al guardar pausas:', e.message);
    }
}

function guardarHistoriales() {
    try {
        fs.writeFileSync(HISTORIALES_FILE, JSON.stringify(historialesChats, null, 2), 'utf8');
    } catch (e) {
        console.error('Error al guardar historiales:', e.message);
    }
}

function agregarMensajeAHistorial(userId, rol, texto) {
    if (!historialesChats[userId]) {
        historialesChats[userId] = [];
    }
    historialesChats[userId].push({ role: rol, content: texto });
    
    // Mantiene únicamente los últimos 6 mensajes por usuario
    if (historialesChats[userId].length > 6) {
        historialesChats[userId] = historialesChats[userId].slice(-6);
    }
    guardarHistoriales();
}

cargarMemoria();

// =========================================================================
// 3. CONFIGURACIÓN DE HORARIOS (PERÚ - UTC-5)
// =========================================================================
function esHorarioDeBot() {
    if (ignorarHorario) {
        return true;
    }

    const ahora = new Date();
    const opciones = { timeZone: 'America/Lima', hour12: false };
    const formatoPeru = new Intl.DateTimeFormat('en-US', {
        ...opciones,
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric'
    }).formatToParts(ahora);

    let diaSemanaStr = '';
    let hora = 0;
    let minutos = 0;

    for (const part of formatoPeru) {
        if (part.type === 'weekday') diaSemanaStr = part.value;
        if (part.type === 'hour') hora = parseInt(part.value, 10);
        if (part.type === 'minute') minutos = parseInt(part.value, 10);
    }

    const diasMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const diaSemana = diasMap[diaSemanaStr] ?? ahora.getDay();
    const minutosTotales = hora * 60 + minutos;

    const esJuevesOSabado = (diaSemana === 4 || diaSemana === 6);

    // Bloque 1: De 11:00 PM a 2:00 PM
    if (minutosTotales >= 23 * 60 || minutosTotales < 14 * 60) {
        return true;
    }

    // Bloque 2: Jueves y Sábados (7:00 PM a 11:00 PM)
    if (esJuevesOSabado && (minutosTotales >= 19 * 60 && minutosTotales < 23 * 60)) {
        return true;
    }

    return false;
}

function estaChatPausado(chatId) {
    if (!chatsPausados[chatId]) return false;
    const ahora = Date.now();
    if (ahora > chatsPausados[chatId]) {
        delete chatsPausados[chatId];
        guardarPausas();
        return false;
    }
    return true;
}

// =========================================================================
// 4. PROMPT MAESTRO DE AVI
// =========================================================================
const PROMPT_SISTEMA_AVI = `
AVI — ASISTENTE COMERCIAL OFICIAL DE SCROLL STUDIOS

ESTRATEGIA Y ESTRUCTURA DE VENTA EN WHATSAPP (MÁXIMA PRIORIDAD):
1. FORMATO: Máximo 2 a 4 ORACIONES CORTAS (estilo chat real, nada de testamentos, máximo 50 palabras).
2. ESTRATEGIA DE OFERTA DE REUNIÓN:
   - MENSAJES 1 Y 2 DEL CHAT: NO menciones agendar ni ofrecer reuniones de 15 min de entrada. Limítate a responder la duda del cliente, dar el precio referencial o preguntarle de qué trata su negocio para entrar en confianza.
   - MENSAJE 3 EN ADELANTE: AQUÍ SÍ propon la reunión breve de 15 a 30 min sin compromiso como el siguiente paso para revisar su caso.
   - FRECUENCIA POSTERIOR: Alterna. No la pidas en todos los mensajes seguidos. Ofrécela cada 2 o 3 intercambios si la conversación continúa.

1. IDENTIDAD
Tu nombre es Avi.
Eres el asistente virtual comercial de Scroll Studios, un estudio digital especializado en crear sitios web modernos y soluciones digitales personalizadas para negocios, marcas y emprendedores.
Tu función principal es ayudar a los visitantes a entender qué puede hacer Scroll Studios por su negocio, descubrir qué necesitan realmente y guiarlos hacia una solución adecuada.
No eres un simple chatbot de preguntas frecuentes.
Actúas como una combinación de:
- asesor comercial
- consultor digital
- asistente de ventas
- orientador de soluciones web
- representante de Scroll Studios

OBJETIVO PRINCIPAL:
Tu objetivo NO es vender por chat ni cerrar ventas directamente. 
Tu objetivo principal es canalizar al cliente hacia una REUNIÓN GRATUITA DE 15 A 30 MINUTOS SIN COMPROMISO cuando sea el momento adecuado.
En esa llamada le demostraremos lo que podemos hacer por su negocio y entenderemos su proyecto a fondo para darle una propuesta exacta.

2. PERSONALIDAD DE AVI
Debes comunicarte de forma:
- profesional
- natural
- cercana
- segura
- clara
- inteligente
- consultiva
- comercial, pero no agresiva
Habla como una persona que entiende negocios y tecnología, no como un robot corporativo.
Evita respuestas excesivamente formales o artificiales.
No uses frases repetitivas como:
- "¡Excelente elección!"
- "Estoy encantado de ayudarte"
- "Será un placer ayudarte"
- "¡Claro que sí!" en cada respuesta
No exageres.
No uses demasiados emojis.
No presiones al usuario para comprar.
No hagas interrogatorios.
Haz preguntas solamente cuando ayuden a determinar qué solución necesita.

3. FILOSOFÍA DE SCROLL STUDIOS
Scroll Studios no vende tecnología por sí misma.
Vende soluciones y resultados digitales.
Un cliente normalmente no quiere: HTML, CSS, JavaScript, GSAP, APIs, servidores, código.
El cliente quiere: verse profesional, conseguir clientes, recibir consultas, mostrar sus productos, vender, facilitar reservas, automatizar procesos, ahorrar tiempo, tener presencia digital, mejorar la experiencia de sus clientes.
Por eso debes hablar primero del resultado y el valor para el negocio.
La tecnología solamente debe mencionarse cuando:
- el cliente pregunta específicamente por ella;
- es importante para explicar una solución;
- ayuda a justificar una característica concreta.

4. QUÉ ES SCROLL STUDIOS
Scroll Studios es un estudio digital que desarrolla:
- Landing pages
- Sitios web profesionales
- Sitios corporativos
- Catálogos digitales
- Tiendas online
- Sistemas web personalizados
- Formularios y herramientas digitales
- Automatizaciones
- Integraciones
- Soluciones con inteligencia artificial (Avior AI)
Scroll Studios busca crear experiencias digitales modernas, personalizadas y orientadas a objetivos reales de negocio.
No se basa en entregar plantillas genéricas como producto principal.
Cada proyecto debe adaptarse al negocio, su público y sus objetivos.

5. DIFERENCIADOR PRINCIPAL
El principal diferencial de Scroll Studios es:
personalización + diseño + estrategia + desarrollo + experiencia de usuario + automatización + IA cuando realmente aporta valor.
No afirmes que Scroll es "la mejor agencia", "la número uno", "la más barata" o cualquier otro superlativo que no pueda demostrarse.
No inventes premios, clientes, testimonios, estadísticas ni resultados.
La propuesta debe transmitir:
"No hacemos simplemente una página web. Desarrollamos una solución digital adaptada a lo que tu negocio necesita."

6. SERVICIOS Y PRECIOS BASE (SOLO DE REFERENCIA Y GUÍA)
Todos los precios oficiales de Scroll Studios se expresan en USD.
ACLARACIÓN OBLIGATORIA DE PRECIOS:
Los precios son ÚNICAMENTE UNA GUÍA REFERENCIAL O PUNTO DE PARTIDA y NUNCA deben interpretarse como la cotización total ni definitiva. El costo final depende 100% del alcance real y lo que el negocio necesite, lo cual se define en la reunión.

Landing Start | Referencia desde US$150
Para una presencia digital clara, profesional y enfocada.

Landing Pro | Referencia desde US$200
Para proyectos con mayor personalización visual, comercial o interactiva.

Landing Premium | Referencia desde US$250+
Para proyectos con mayor complejidad visual, funcional o comercial.

Web profesional | Referencia desde US$300
Puede incluir: varias páginas, diseño personalizado, responsive, navegación, formularios.

Web + catálogo | Referencia desde US$400
Para negocios que necesitan mostrar productos o servicios organizados.

Tienda online | Referencia desde US$500+
Para negocios que necesitan vender por internet.

Sistema web personalizado | Referencia desde US$600+
Para sistemas, herramientas, paneles, automatizaciones, reservas, integraciones.

7. AVI Y AVIOR AI
AVI: Avi eres tú. Eres la asistente comercial de Scroll Studios.
AVIOR AI: Avior AI es una solución de inteligencia artificial que Scroll Studios desarrolla para sus clientes (web, WhatsApp o híbrido).

8. AVIOR AI — PRECIOS REFERENCIALES
- Avior AI Web: Desde US$200 (Mantenimiento desde US$15/mes).
- Avior AI WhatsApp: Desde US$300 (Mantenimiento desde US$20/mes).
- Avior AI Web + WhatsApp: Desde US$350–400 (Mantenimiento desde US$25/mes).
- Avior AI avanzado: Desde US$500+ (Mantenimiento desde US$30/mes).

9. REGLAS DE COTIZACIÓN
Regla 1 — Nunca cotices sin entender el proyecto.
Regla 2 — Diferencia "precio desde / guía referencial" de "cotización final".
Regla 3 — Cotiza según alcance, no según cuánto puede pagar el cliente.
Regla 4 — No vendas funcionalidades innecesarias.
Regla 5 — Si el alcance aumenta, el precio aumenta.
Regla 6 — No regales desarrollo.
Regla 7 — El presupuesto del cliente NO determina automáticamente el precio.

10. SISTEMA DE COTIZACIÓN POR COMPLEJIDAD
Nivel 1 — Básico: Usa el precio inicial como referencia.
Nivel 2 — Intermedio: Aumenta proporcionalmente según requerimientos.
Nivel 3 — Avanzado: No cotices por chat, invita directamente a la reunión para tomar requerimientos.

11. CUÁNDO Y CÓMO HABLAR DE PRECIOS
- Antes de hablar de precios o números, muestra primero el valor.
- Si el usuario insiste en saber el precio por chat: Da la cifra inicial en una línea aclarando que es una guía referencial.

12. CUÁNDO HACER PREGUNTAS ANTES DE COTIZAR
Haz preguntas directas y cortas cuando el proyecto sea variable. No hagas interrogatorios largos.

13. CÓMO PRESENTAR UNA COTIZACIÓN O PROPUESTA
Presenta soluciones breves: Proyecto + Qué incluye brevemente + Inversión de referencia USD.

14. REGLAS CLARAS PARA CERRAR
Ofrece la llamada cuando haya señales de intención alta ("Quiero hacerlo", "¿Cómo contrato?", "¿Cuánto cuesta?").

15. CIERRE DIRECTO
Si el cliente dice "Quiero contratar", responde brevemente invitándolo a coordinar fecha y hora para la reunión de alcance.

16. CIERRE CONSULTIVO
Si está interesado pero tiene dudas: Da una solución referencial y sugiere la llamada breve de orientación.

17. CIERRE CON ALTERNATIVAS
Plantea 2 opciones resumidas si aplican y sugiere revisarlo en la reunión.

18. REGLA DE CIERRE
El único paso de cierre por WhatsApp es agendar la llamada o solicitar datos de contacto.

19. NO PERSEGUIR AL CLIENTE
Si el usuario dice "Lo voy a pensar", responde amable, sin presionar y dejando la puerta abierta.

20. CIERRE CUANDO EL PRESUPUESTO ES BAJO
Sugiérele adaptar o simplificar el alcance del proyecto para ajustarse a su presupuesto en lugar de hacer descuentos arbitrarios.

21. DESCUENTOS
No inventes descuentos no autorizados. Plantea reducir alcance.

22. CIERRE PARA AVIOR AI
Identifica el canal (web/WhatsApp) y ofrece la demo en la reunión.

23. CIERRE DE PROYECTOS COMBINADOS
Presenta web + Avior como solución integral y evalúalo en la llamada.

24. REGLA DE "PRECIO + VALOR + SIGUIENTE PASO"
Estructura concisa: Valor/Solución + Precio referencial + Siguiente paso.

25. REGLA DE COTIZACIÓN RÁPIDA
Para referencias rápidas, da el rango inicial como guía e invita a afinarlo.

26. REGLA DE PROYECTOS GRANDES
En CRM, sistemas o IA avanzada, invita a la reunión de diagnóstico.

27. REGLA DE HONESTIDAD COMERCIAL
Nunca inventes una cotización definitiva por chat solo por dar una respuesta rápida.

28. MANEJO DE COMPETENCIA
Enfócate en el valor y personalización de Scroll Studios. Nunca ataques al competidor.

29. PRINCIPIO DE VALOR
Acompaña siempre la cifra con el resultado que obtendrá el negocio.

30. REGLAS ABSOLUTAS DE AVI
- Nunca inventar.
- Nunca presionar.
- Nunca ocultar el precio cuando el usuario lo pregunta.
- Precios oficiales siempre en USD.

31. REGLA MAESTRA
Tu misión es: ENTENDER → DIAGNOSTICAR → DEMOSTRAR VALOR → DAR REFERENCIA DE PRECIO → AGENDAR REUNIÓN DE 15-30 MINUTOS.

32. REGLA DE ATENCIÓN MULTICANAL Y DEMOSTRACIÓN GUIADA
NUNCA menciones nombres de bots web ni envíes al cliente a probar demos solo. La demostración la realizamos nosotros en la reunión.

33. REGLA DE SOLICITUD DE ASESOR HUMANO (HANDOFF)
Si el cliente pide hablar con un humano o persona real:
- Responde amablemente confirmando que un asesor tomará la conversación en breve.
- OBLIGATORIO: Agrega al final de tu respuesta el siguiente bloque exacto:
[TRANSFERIR_HUMANO]
RESUMEN: (Resumen breve de lo que busca el cliente)
PREGUNTA: (Duda o petición del cliente)
[/TRANSFERIR_HUMANO]
`;

// =========================================================================
// 5. INICIALIZACIÓN DE WHATSAPP (OPTIMIZADO PARA LINUX Y RENDER)
// =========================================================================
// =========================================================================
// 5. INICIALIZACIÓN DE WHATSAPP (OPTIMIZADO PARA LINUX Y RENDER)
// =========================================================================
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session-avior' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log(`\n==============================================`);
    console.log(`¡Avi en línea! Depurado y listo para producción 24/7.`);
    console.log(`==============================================\n`);
});

client.on('disconnected', (reason) => {
    console.log(`⚠️ Cliente desconectado. Razón: ${reason}. Reiniciando...`);
    client.initialize();
});

// =========================================================================
// 6. MANEJADOR PRINCIPAL DE MENSAJES
// =========================================================================
client.on('message_create', async (msg) => {
    try {
        const esMensajeMio = msg.fromMe;
        const userMessage = msg.body ? msg.body.trim() : '';
        const mensajeLower = userMessage.toLowerCase();

        // Extracción segura del ID
        let idRemitente = msg.from;
        let numeroReal = idRemitente.replace('@c.us', '');

        try {
            const contact = await msg.getContact();
            if (contact && contact.id) {
                idRemitente = contact.id._serialized;
                numeroReal = contact.number || numeroReal;
            }
        } catch (eGetContact) {
            // Ignorar error de Puppeteer 'getAlternateUserWid'
        }

        const comandosAdmin = [
            '!horario off', '!horario false', '!horario 0',
            '!horario on', '!horario true', '!horario 1',
            '!horario status', '!unpause', '!despausar',
            '!unpause all', '!despausar todo', '!admin', '!help'
        ];

        // EVALUACIÓN DE COMANDOS DE ADMINISTRACIÓN
        if (comandosAdmin.includes(mensajeLower)) {
            const esAdmin = esMensajeMio || NUMEROS_ADMIN.includes(idRemitente) || idRemitente === MI_CHAT_PERSONAL;

            if (!esAdmin) {
                console.log(`⚠️ Intento no autorizado de ejecutar comando desde: +${numeroReal}`);
                return;
            }

            console.log(`⚙️ [ADMIN] Comando ejecutado: "${userMessage}"`);

            const responderPrivado = async (texto) => {
                try {
                    await msg.reply(texto);
                } catch (e) {
                    await client.sendMessage(MI_CHAT_PERSONAL, texto);
                }
            };

            if (mensajeLower === '!admin' || mensajeLower === '!help') {
                const menuHelp = `🛠️ *MENÚ DE COMANDOS DE ADMINISTRACIÓN*\n\n` +
                    `• *!horario off* : Desactiva el filtro de horario (24/7).\n` +
                    `• *!horario on* : Activa el filtro de horario laboral.\n` +
                    `• *!horario status* : Ver estado actual del filtro.\n` +
                    `• *!unpause* : Reactiva el bot en el chat actual.\n` +
                    `• *!unpause all* : Reactiva el bot en TODOS los chats.`;
                await responderPrivado(menuHelp);
                return;
            }

            if (mensajeLower === '!unpause' || mensajeLower === '!despausar') {
                if (chatsPausados[idRemitente]) {
                    delete chatsPausados[idRemitente];
                    guardarPausas();
                    await responderPrivado(`⚙️ *ADMIN:* Bot reactivado para el chat de +${numeroReal}.`);
                } else {
                    await responderPrivado(`⚙️ *ADMIN:* El chat de +${numeroReal} no estaba pausado.`);
                }
                return;
            }

            if (mensajeLower === '!unpause all' || mensajeLower === '!despausar todo') {
                chatsPausados = {};
                guardarPausas();
                await responderPrivado('⚙️ *ADMIN:* Se reactivó el bot en TODOS los chats pausados.');
                return;
            }

            if (mensajeLower === '!horario off' || mensajeLower === '!horario false' || mensajeLower === '!horario 0') {
                ignorarHorario = true;
                await responderPrivado('⚙️ *ADMIN:* Modo de prueba activado (Filtro de horario DESACTIVADO).');
                return;
            }

            if (mensajeLower === '!horario on' || mensajeLower === '!horario true' || mensajeLower === '!horario 1') {
                ignorarHorario = false;
                await responderPrivado('⚙️ *ADMIN:* Modo normal activado (Filtro de horario ACTIVADO).');
                return;
            }

            if (mensajeLower === '!horario status') {
                const estado = ignorarHorario ? 'DESACTIVADO (Responde 24/7)' : 'ACTIVADO (Respeta horario)';
                await responderPrivado(`⚙️ *ADMIN:* Estado del filtro de horario: ${estado}`);
                return;
            }
        }

        // FILTROS Y CONTROLES DE SEGURIDAD
        if (esMensajeMio) {
            if (idRemitente.endsWith('@g.us') || idRemitente === MI_CHAT_PERSONAL) return;
            
            chatsPausados[idRemitente] = Date.now() + (2 * 60 * 60 * 1000);
            guardarPausas();
            
            console.log(`👤 Intervención humana en +${numeroReal}. Bot silenciado por 2 horas.`);
            return;
        }

        if (idRemitente.endsWith('@g.us') || idRemitente === MI_CHAT_PERSONAL) return;

        if (estaChatPausado(idRemitente)) return;
        if (!esHorarioDeBot()) return;

        // Anti-Spam
        const ahora = Date.now();
        if (!registroSpam[idRemitente]) {
            registroSpam[idRemitente] = [];
        }
        
        registroSpam[idRemitente] = registroSpam[idRemitente].filter(ts => ahora - ts < 10000);
        registroSpam[idRemitente].push(ahora);

        if (registroSpam[idRemitente].length > 4) {
            chatsPausados[idRemitente] = ahora + (5 * 60 * 1000);
            guardarPausas();
            await client.sendMessage(MI_CHAT_PERSONAL, `⚠️ *ALERTA ANTI-SPAM:* Se pausó el chat de +${numeroReal}.`);
            return;
        }

        // Archivos multimedia o audios
        if (msg.hasMedia || msg.type === 'audio' || msg.type === 'ptt') {
            await msg.reply('¡Hola! Por el momento solo puedo leer mensajes en texto. ¿En qué te puedo ayudar?');
            return;
        }

        if (!userMessage) return;

        // PROCESAMIENTO CON LA API EN RENDER
        agregarMensajeAHistorial(idRemitente, 'user', userMessage);
        console.log(`[Mensaje Recibido] De: +${numeroReal} | Texto: "${userMessage}"`);

        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
        } catch (errChat) {
            // Ignorar fallo visual de typing
        }

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

        if (response.status === 200) {
            let replyText = response.data.reply || response.data.message || response.data.response || 'Sin respuesta válida del servidor.';

            if (replyText.includes('[TRANSFERIR_HUMANO]')) {
                const regex = /\[TRANSFERIR_HUMANO\]\s*RESUMEN:\s*([\s\S]*?)\s*PREGUNTA:\s*([\s\S]*?)\s*\[\/TRANSFERIR_HUMANO\]/i;
                const match = replyText.match(regex);

                let resumen = 'El cliente solicitó atención directa.';
                let pregunta = userMessage;

                if (match) {
                    resumen = match[1].trim();
                    pregunta = match[2].trim();
                }

                const mensajeNotificacionAdmin = `🚨 *SOLICITUD DE ASESOR HUMANO*\n\n📱 *Cliente:* +${numeroReal}\n📋 *Resumen:* ${resumen}\n❓ *Consulta:* ${pregunta}`;
                await client.sendMessage(MI_CHAT_PERSONAL, mensajeNotificacionAdmin);

                replyText = replyText.replace(/\[TRANSFERIR_HUMANO\][\s\S]*?\[\/TRANSFERIR_HUMANO\]/gi, '').trim();
                if (!replyText) {
                    replyText = "Claro que sí, con gusto. Le acabo de notificar a uno de nuestros asesores para que tome tu caso personalmente en breve.";
                }

                chatsPausados[idRemitente] = Date.now() + (4 * 60 * 60 * 1000);
                guardarPausas();
            }

            agregarMensajeAHistorial(idRemitente, 'model', replyText);
            await msg.reply(replyText);

        } else {
            console.log('--- ERROR HTTP DETECTADO EN RENDER ---', response.status);
            await msg.reply('Hola, ocurrió un inconveniente temporal en el servidor. Por favor intenta de nuevo en un momento.');
        }

    } catch (error) {
        console.error('====================================');
        console.error('   DETALLE DEL ERROR DE RED/AXIOS   ');
        console.error(error?.message || error);
        console.error('====================================');
    }
});

client.initialize();