// db-ventana.js
// Decide CUÁNDO puede estar habilitada la base de datos Neon y CUÁNDO se guardan los cambios.
//
//   "Habilitada" no significa "despierta": solo permite que una conexión la despierte.
//   Neon solo cobra horas mientras está despierta (cada guardado la despierta ~5 min).
//
// Variables de entorno (todas opcionales):
//   DB_VENTANA  = "22:00-06:30"   hora de Lima (por defecto); admite varios tramos "07:00-09:00,13:00-23:00"
//                                 y tramos que cruzan medianoche "22:00-02:00"
//   FLUSH_MIN   = 20              cada cuántos minutos se guardan los cambios pendientes
const neon = require('./neon-control');
const { flushTodo, hayPendiente } = require('./auth-postgres');

const VENTANA = process.env.DB_VENTANA || '22:00-06:30';
const FLUSH_MS = (Number(process.env.FLUSH_MIN) || 20) * 60 * 1000;

let modo = 'auto';        // 'auto' (sigue la ventana) | 'on' (siempre habilitada) | 'off' (siempre apagada)
let habilitada = null;    // estado que conocemos de Neon
let ultimoFlush = Date.now();
let pool = null;
let forzarSi = () => false;
let timer = null;

function minutosLima() {
    const p = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Lima', hourCycle: 'h23', hour: 'numeric', minute: 'numeric'
    }).formatToParts(new Date());
    const h = parseInt(p.find((x) => x.type === 'hour').value, 10) % 24;
    const m = parseInt(p.find((x) => x.type === 'minute').value, 10);
    return h * 60 + m;
}

function dentroDeVentana() {
    const ahora = minutosLima();
    return VENTANA.split(',').some((tramo) => {
        const [a, b] = tramo.trim().split('-').map((t) => {
            const [h, m] = t.split(':').map(Number);
            return h * 60 + (m || 0);
        });
        return a <= b ? (ahora >= a && ahora < b) : (ahora >= a || ahora < b);
    });
}

function debeEstarHabilitada() {
    if (forzarSi()) return true;   // p. ej. mientras se vincula WhatsApp por primera vez
    if (modo === 'on') return true;
    if (modo === 'off') return false;
    return dentroDeVentana();
}

async function asegurarHabilitada() {
    if (habilitada) return;
    await neon.habilitar();
    habilitada = true;
    console.log('☀️ Neon habilitado');
}

async function guardar(motivo) {
    try {
        const n = await flushTodo(pool);
        ultimoFlush = Date.now();
        if (n) console.log(`💾 Guardado (${motivo}): ${n} registros`);
        return true;
    } catch (e) {
        console.error(`❌ Falló el guardado (${motivo}):`, e?.message || e);
        return false;
    }
}

async function tick() {
    try {
        if (debeEstarHabilitada()) {
            await asegurarHabilitada();
            if (hayPendiente() && Date.now() - ultimoFlush >= FLUSH_MS) await guardar('periódico');
        } else if (habilitada) {
            // Cierre del día: guarda lo pendiente y deshabilita (suspende al instante)
            if (hayPendiente()) await guardar('antes de apagar Neon');
            if (!hayPendiente()) {
                await neon.deshabilitar();
                habilitada = false;
                console.log('🌙 Neon deshabilitado (fuera de ventana)');
            }
        }
    } catch (e) {
        console.error('db-ventana:', e?.message || e);
    }
}

// Llamar en main() ANTES de abrir el pool de consultas. Siempre habilita al arrancar
// (hay que leer la sesión); si es de noche, el siguiente tick guarda y vuelve a apagar.
async function arrancar(p, opciones = {}) {
    pool = p;
    if (opciones.forzarSi) forzarSi = opciones.forzarSi;
    try { await neon.fijarTamanoMinimo(); } catch (e) { console.warn('No se pudo fijar 0.25 CU:', e?.message || e); }
    try { await neon.habilitar(); habilitada = true; } catch (e) {
        console.error('No se pudo habilitar Neon por API (¿ya estaba habilitado?):', e?.message || e);
        habilitada = true;
    }
    timer = setInterval(tick, 60 * 1000);
}

// Llamar al apagar (SIGTERM). NO deshabilita Neon: la instancia nueva podría estar arrancando.
async function alApagar() {
    if (timer) clearInterval(timer);
    try { await asegurarHabilitada(); } catch (e) {}
    await guardar('apagado');
}

// Comandos admin: !db on | !db off | !db auto | !db status | !db flush
async function comando(cmd) {
    const sub = cmd.replace('!db', '').trim();
    try {
        if (sub === 'on') { modo = 'on'; await tick(); return '⚙️ *DB:* modo ON. Neon habilitado (se despierta solo al guardar, cada ' + FLUSH_MS / 60000 + ' min).'; }
        if (sub === 'off') {
            modo = 'off';
            await tick();
            return hayPendiente()
                ? '⚠️ *DB:* modo OFF pedido, pero el guardado falló; sigo con datos en memoria. Reintento en 1 min.'
                : '⚙️ *DB:* modo OFF. Neon deshabilitado. El bot sigue respondiendo desde memoria. Ojo: si Render reinicia mientras está OFF, se pierden los cambios no guardados.';
        }
        if (sub === 'auto') { modo = 'auto'; await tick(); return `⚙️ *DB:* modo AUTO. Ventana Lima: ${VENTANA}.`; }
        if (sub === 'flush') {
            await asegurarHabilitada();
            const ok = await guardar('manual');
            return ok ? '⚙️ *DB:* guardado manual hecho.' : '⚠️ *DB:* el guardado falló, revisa los logs.';
        }
        if (sub === 'status') {
            let real = '';
            try {
                const e = await neon.estado();
                if (e) real = `\n• Estado real Neon: ${e.disabled ? 'deshabilitado' : 'habilitado'} / ${e.current_state}`;
            } catch (err) {}
            return `⚙️ *DB:* modo ${modo.toUpperCase()}\n• Ventana Lima: ${VENTANA} (ahora ${dentroDeVentana() ? 'DENTRO' : 'FUERA'})\n• Habilitada (según bot): ${habilitada}\n• Cambios pendientes: ${hayPendiente() ? 'sí' : 'no'}${real}`;
        }
    } catch (e) {
        return `⚠️ *DB:* error: ${e?.message || e}`;
    }
    return '⚙️ *DB:* usa !db on | !db off | !db auto | !db flush | !db status';
}

module.exports = { arrancar, alApagar, comando };