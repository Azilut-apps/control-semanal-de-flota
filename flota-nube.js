// flota-nube.js
// Capa nube con Firestore y Authentication.
// Operarios: solo lectura, sin login. Altas ("Recordar mis datos") en colección "altas".
// Historial: cada registro se enlaza a su alta (altaId) y a su semana (semanaInicio).
// Administradores: alta, edición y baja lógica de unidades. Acceso oculto (5 toques en el título).
// Integrado en index.html (módulo cargado al final del body).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, writeBatch,
  addDoc, getDocs, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Configuración de la app web "contro_flota" (proyecto azilut-flota).
// La apiKey no es secreta en Firebase: la seguridad la dan las reglas de Firestore y la autenticación.
const firebaseConfig = {
  apiKey: "AIzaSyAH9BIZe9fPJtF0JAa04GMMc2hXzirDs5k",
  authDomain: "azilut-flota.firebaseapp.com",
  projectId: "azilut-flota",
  storageBucket: "azilut-flota.firebasestorage.app",
  messagingSenderId: "351568202805",
  appId: "1:351568202805:web:7b933b3bb344daae4a357c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const TIPOS_DOC = [
  { id: "SEGURO", label: "Seguro" },
  { id: "VTV", label: "VTV / RTO" },
  { id: "CEDULA_VERDE", label: "Cédula verde" },
  { id: "CREDENCIAL_YPF", label: "Credencial autogestionable YPF" }
];

// Listado inicial tomado del array `vehicles` de index.html. Solo para la carga inicial en la nube.
const LISTADO_INICIAL = vehicles.map(v => ({ ...v }));

const CLASES = {
  red: "bg-red-100 text-red-700",
  amber: "bg-amber-100 text-amber-700",
  green: "bg-green-100 text-green-700",
  slate: "bg-slate-100 text-slate-500"
};

let unidadesNube = [];      // todas las unidades, incluidas las dadas de baja
let documentosCache = {};   // { "KEF062_SEGURO": {...} }
let docVehiculo = null;     // unidad abierta en el modal Documentos
let usuarioAdmin = null;
let toques = 0;
let toqueTimer = null;

// ---------- utilidades ----------

const patenteDe = v => v.domain.replace(/\s+/g, "").toUpperCase();

// Firestore guarda AAAA-MM-DD. La app muestra DD-MM-AAAA.
function fmtFecha(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// Fuente única en index.html (window.claveRegistro). Alias local para no duplicar la lógica.
const claveRegistro = r => window.claveRegistro(r);

// Semáforo calculado en la app, no guardado.
function semaforo(iso) {
  if (!iso) return { color: "slate", txt: "Sin cargar", dias: null };
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split("-").map(Number);
  const dias = Math.round((new Date(y, m - 1, d) - hoy) / 86400000);
  if (dias < 0) return { color: "red", txt: "Vencido", dias };
  if (dias <= 30) return { color: "amber", txt: `Vence en ${dias} días`, dias };
  return { color: "green", txt: "Vigente", dias };
}

function resumenSemaforoUnidad(v) {
  if (!v) return { color: "slate", texto: "" };
  const pat = patenteDe(v);
  const items = [
    ...TIPOS_DOC.map(t => ({ label: t.label, s: semaforo(documentosCache[`${pat}_${t.id}`]?.vencimiento) })),
    { label: "Matafuego", s: semaforo(v.extintorVencimiento) }
  ];

  const vencidos = items.filter(i => i.s.color === "red").map(i => i.label);
  if (vencidos.length > 0) {
    const texto = vencidos.length === 1
      ? `${vencidos[0]} vencido`
      : `${vencidos[0]} +${vencidos.length - 1} vencidos`;
    return { color: "red", texto };
  }

  const porVencer = items
    .filter(i => i.s.color === "amber")
    .sort((a, b) => a.s.dias - b.s.dias);
  if (porVencer.length > 0) {
    const p = porVencer[0];
    const texto = porVencer.length === 1
      ? `${p.label} (${p.s.dias}d)`
      : `${p.label} (${p.s.dias}d) +${porVencer.length - 1}`;
    return { color: "amber", texto };
  }

  if (items.every(i => i.s.color === "green")) {
    return { color: "green", texto: "" };
  }

  const faltantes = items.filter(i => i.s.color === "slate").map(i => i.label);
  const textoFalta = faltantes.length === 1
    ? `Falta ${faltantes[0]}`
    : (faltantes.length === items.length ? "Sin docs" : `Faltan ${faltantes.length} docs`);
  return { color: "slate", texto: textoFalta };
}

function cerrarModal(id) {
  document.getElementById(id)?.remove();
}

function modalAbierto(id) {
  return !!document.getElementById(id);
}

function mostrarModal(id, html) {
  cerrarModal(id);
  const o = document.createElement("div");
  o.id = id;
  o.className = "fixed inset-0 bg-slate-900/60 flex items-center justify-center p-4 z-[60]";
  o.innerHTML = `<div class="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5 shadow-2xl">${html}</div>`;
  document.body.appendChild(o);
}

const ordenarPorId = (a, b) => a.id.localeCompare(b.id, "es", { numeric: true });

// Convierte documentos de Firestore al formato de `vehicles` de index.html. Solo unidades activas.
function aListaOperativa(unidades) {
  return unidades
    .filter(u => u.activo !== false)
    .sort(ordenarPorId)
    .map(u => ({
      id: u.id,
      description: u.descripcion,
      brand: u.marca,
      year: u.anio,
      domain: u.patente,
      extintorVencimiento: u.extintorVencimiento || ""
    }));
}

// ---------- sincronización en tiempo real ----------

onSnapshot(collection(db, "vehiculos"), snap => {
  unidadesNube = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Si la colección está vacía, la app conserva el listado local.
  if (unidadesNube.length > 0) {
    vehicles.splice(0, vehicles.length, ...aListaOperativa(unidadesNube));
    if (state.view === "list") window.render();
  }
  if (modalAbierto("admin-modal")) panelAdmin();
}, err => console.error("vehiculos:", err));

onSnapshot(collection(db, "documentos"), snap => {
  documentosCache = {};
  snap.docs.forEach(d => { documentosCache[d.id] = d.data(); });
  if (modalAbierto("docs-modal")) renderDocs();
  if (window.state?.view === "list" && window.render) window.render();
}, err => console.error("documentos:", err));

onSnapshot(collection(db, "historial"), snap => {
  const nube = snap.docs.map(d => d.data());
  if (nube.length > 0 && window.state) {
    // Fusionar historial nube con local sin duplicar (clave: alta + semana, o unidad + fecha)
    const mapa = new Map();
    (window.state.history || []).forEach(r => mapa.set(claveRegistro(r), r));
    nube.forEach(r => {
      const key = claveRegistro(r);
      const local = mapa.get(key);
      if (!local || new Date(r.timestamp) >= new Date(local.timestamp)) {
        mapa.set(key, r);
      }
    });
    window.state.history = Array.from(mapa.values())
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    localStorage.setItem("vehicle_history", JSON.stringify(window.state.history));
    if (modalAbierto("historial-admin-modal")) verHistorialAdmin();
    if (modalAbierto("puntajes-admin-modal")) verPuntajesAdmin();
  }
}, err => console.error("historial:", err));

async function guardarEnNube(record) {
  if (!record || !record.vehicleId || !record.weekDate) return;
  try {
    await setDoc(doc(db, "historial", claveRegistro(record)), record, { merge: true });
  } catch (e) {
    console.error("Error guardando historial en nube:", e);
  }
}

onAuthStateChanged(auth, u => { usuarioAdmin = u; });

// ---------- altas ("Recordar mis datos") ----------

const VENTANA_CONFLICTO_MS = 5 * 60 * 1000;

// Fuente única en index.html (window.lunesDe).
const lunesDe = iso => window.lunesDe(iso);

// Crea un alta nueva. Devuelve el ID del alta, o null si no se creó.
// Control de conflicto solo en el cliente: orienta al operario, no es seguridad.
async function crearAlta() {
  const s = window.state;
  const v = s.selectedVehicle;
  const f = s.formData;
  if (!v) return null;

  if (!f.driverName || !f.driverDni || !f.startMileage || !f.weekDate) {
    alert("Completá conductor, DNI, km y fecha antes de recordar datos.");
    return null;
  }

  try {
    const snap = await getDocs(query(collection(db, "altas"), where("unidadId", "==", v.id)));
    const ahora = Date.now();
    const conflicto = snap.docs.map(d => d.data()).find(a => {
      const t = a.creado?.toMillis?.() ?? 0;
      return ahora - t < VENTANA_CONFLICTO_MS && a.dni !== f.driverDni;
    });
    if (conflicto) {
      alert(`Verificar: ${v.id} fue registrada hace instantes por otro conductor (DNI ${conflicto.dni}).`);
      return null;
    }

    const ref = await addDoc(collection(db, "altas"), {
      unidadId: v.id,
      fecha: f.weekDate,
      semanaInicio: lunesDe(f.weekDate),
      conductor: f.driverName,
      dni: f.driverDni,
      km: Number(f.startMileage),
      creado: serverTimestamp()
    });
    return ref.id;
  } catch (e) {
    alert("No se pudo registrar el alta: " + e.message);
    return null;
  }
}

// ---------- Documentos (operarios) ----------

function abrirDocumentos(vehiculoId = null) {
  docVehiculo = vehiculoId
    ? vehicles.find(v => v.id === vehiculoId)
    : state.selectedVehicle;
  if (!docVehiculo) return;
  renderDocs();
}

function renderDocs() {
  const v = docVehiculo;
  const pat = patenteDe(v);

  const filas = TIPOS_DOC.map(t => {
    const id = `${pat}_${t.id}`;
    const d = documentosCache[id];
    const s = semaforo(d?.vencimiento);
    const tieneArchivo = !!d?.archivoUrl;
    return `
      <div class="flex items-center justify-between gap-2 p-3 border border-slate-200 rounded-xl mb-2">
        <div>
          <div class="font-bold text-sm">${t.label}</div>
          <div class="text-xs text-slate-500">Vence: ${fmtFecha(d?.vencimiento)}</div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] px-2 py-1 rounded-full font-bold ${CLASES[s.color]}">${s.txt}</span>
          <button ${tieneArchivo ? "" : "disabled"} onclick="abrirArchivo('${id}')"
            class="text-xs font-bold px-3 py-2 rounded-lg bg-slate-800 text-white disabled:opacity-30">Ver PDF</button>
        </div>
      </div>`;
  }).join("");

  const ext = semaforo(v.extintorVencimiento);
  const filaExt = `
      <div class="flex items-center justify-between gap-2 p-3 border border-slate-200 rounded-xl">
        <div>
          <div class="font-bold text-sm">Matafuego</div>
          <div class="text-xs text-slate-500">Vence: ${fmtFecha(v.extintorVencimiento)} · sin documento</div>
        </div>
        <span class="text-[10px] px-2 py-1 rounded-full font-bold ${CLASES[ext.color]}">${ext.txt}</span>
      </div>`;

  mostrarModal("docs-modal", `
    <div class="flex justify-between items-start mb-4">
      <div>
        <h3 class="font-black text-lg">Documentos</h3>
        <p class="text-xs text-slate-500">${v.id} · ${v.description} · ${v.domain}</p>
      </div>
      <button onclick="cerrarModal('docs-modal')" class="text-slate-400 text-2xl px-2">&times;</button>
    </div>
    ${filas}
    ${filaExt}`);
}

function abrirArchivo(id) {
  const url = documentosCache[id]?.archivoUrl;
  if (url) window.open(url, "_blank", "noopener");
}

// ---------- acceso administrador (oculto: 5 toques en el título) ----------

function tapTitulo() {
  toques++;
  clearTimeout(toqueTimer);
  toqueTimer = setTimeout(() => { toques = 0; }, 3000);
  if (toques < 5) return;
  toques = 0;
  if (usuarioAdmin) panelAdmin();
  else loginAdmin();
}

function loginAdmin() {
  mostrarModal("login-modal", `
    <h3 class="font-black text-lg mb-3">Acceso administrador</h3>
    <input id="adm-email" type="email" placeholder="Correo" class="w-full border border-slate-300 p-3 rounded-xl mb-2">
    <div style="position:relative; margin-bottom:8px;">
      <input id="adm-pass" type="password" placeholder="Contraseña" class="w-full border border-slate-300 p-3 rounded-xl" style="padding-right:44px;">
      <button type="button" onclick="toggleVerPass()" id="adm-eye" title="Ver/Ocultar contraseña"
        style="position:absolute; right:12px; top:50%; transform:translateY(-50%); background:transparent; border:none; padding:4px; color:#64748b; cursor:pointer; display:flex; align-items:center;">
        <svg id="eye-open" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        <svg id="eye-closed" xmlns="http://www.w3.org/2000/svg" width="20" height="20" style="display:none;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
        </svg>
      </button>
    </div>
    <p id="adm-err" class="text-red-600 text-xs mb-2"></p>
    <div class="flex justify-end gap-2">
      <button onclick="cerrarModal('login-modal')" class="px-4 py-2 text-sm text-slate-500">Cancelar</button>
      <button onclick="entrarAdmin()" class="px-4 py-2 text-sm bg-slate-800 text-white rounded-lg font-bold">Entrar</button>
    </div>`);
}

function toggleVerPass() {
  const input = document.getElementById("adm-pass");
  const open = document.getElementById("eye-open");
  const closed = document.getElementById("eye-closed");
  if (!input) return;
  const mostrar = input.type === "password";
  input.type = mostrar ? "text" : "password";
  if (open) open.style.display = mostrar ? "none" : "block";
  if (closed) closed.style.display = mostrar ? "block" : "none";
}

async function entrarAdmin() {
  const email = document.getElementById("adm-email").value.trim();
  const pass = document.getElementById("adm-pass").value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    cerrarModal("login-modal");
    panelAdmin();
  } catch (e) {
    document.getElementById("adm-err").textContent = "Correo o contraseña incorrectos.";
  }
}

async function salirAdmin() {
  await signOut(auth);
  cerrarModal("admin-modal");
}

// ---------- ABM de unidades (solo administrador) ----------

function panelAdmin() {
  const filas = unidadesNube
    .slice()
    .sort(ordenarPorId)
    .map(u => {
      const baja = u.activo === false;
      return `
      <div class="flex items-center justify-between gap-2 p-3 border border-slate-200 rounded-xl mb-2 ${baja ? "opacity-50" : ""}">
        <div>
          <div class="font-bold text-sm">${u.id} · ${u.descripcion}</div>
          <div class="text-xs text-slate-500">${u.patente}${baja ? " · DADA DE BAJA" : ""}</div>
        </div>
        <div class="flex gap-2">
          <button onclick="formUnidad('${u.id}')" class="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300">Editar</button>
          <button onclick="toggleBaja('${u.id}')" class="text-xs font-bold px-3 py-2 rounded-lg text-white ${baja ? "bg-green-600" : "bg-red-600"}">${baja ? "Reactivar" : "Dar de baja"}</button>
        </div>
      </div>`;
    }).join("");

  const acciones = `
    <div class="flex flex-wrap gap-2 mb-4">
      <button onclick="formUnidad(null)" class="px-3 py-2 text-xs bg-slate-800 text-white rounded-lg font-bold">+ Nueva unidad</button>
      <button onclick="verHistorialAdmin()" class="px-3 py-2 text-xs bg-blue-700 text-white rounded-lg font-bold">📋 Historial por Unidad</button>
      <button onclick="verPuntajesAdmin()" class="px-3 py-2 text-xs bg-amber-600 text-white rounded-lg font-bold">🏆 Puntaje Conductores</button>
      <button onclick="verInformeAdmin()" class="px-3 py-2 text-xs bg-green-700 text-white rounded-lg font-bold">📊 Informe Mensual</button>
      <button onclick="verInstructivoAdmin()" class="px-3 py-2 text-xs border border-slate-300 rounded-lg font-bold text-slate-700">ℹ️ Instructivo Carga</button>
      <button onclick="exportarRespaldoAdmin()" class="px-3 py-2 text-xs bg-slate-700 text-white rounded-lg font-bold">💾 Exportar respaldo</button>
      <label class="px-3 py-2 text-xs bg-slate-200 text-slate-800 rounded-lg font-bold cursor-pointer hover:bg-slate-300">
        📂 Restaurar datos
        <input type="file" class="hidden" accept=".json" onchange="restaurarRespaldoAdmin(this)">
      </label>
      ${unidadesNube.length === 0
        ? `<button onclick="cargarIniciales()" class="px-3 py-2 text-xs border border-slate-300 rounded-lg font-bold">Cargar unidades iniciales</button>`
        : ""}
    </div>`;

  mostrarModal("admin-modal", `
    <div class="flex justify-between items-center mb-4">
      <h3 class="font-black text-lg">Administración de unidades</h3>
      <button onclick="salirAdmin()" class="text-xs font-bold text-slate-500 px-3 py-2">Salir</button>
    </div>
    ${acciones}
    ${filas || '<p class="text-sm text-slate-500">Sin unidades cargadas.</p>'}`);
}

function campo(idCampo, label, valor, deshabilitado = false, tipo = "text") {
  return `
    <label class="block text-xs font-bold text-slate-500 uppercase mt-2 mb-1">${label}</label>
    <input id="${idCampo}" type="${tipo}" value="${valor ?? ""}" ${deshabilitado ? "disabled" : ""}
      class="w-full border border-slate-300 p-3 rounded-xl">`;
}

function formUnidad(id) {
  const u = id ? (unidadesNube.find(x => x.id === id) || {}) : {};
  mostrarModal("unidad-modal", `
    <h3 class="font-black text-lg mb-1">${id ? "Editar unidad " + id : "Nueva unidad"}</h3>
    ${campo("u-id", "ID (ej. CA-26)", id || "", !!id)}
    ${campo("u-desc", "Descripción", u.descripcion)}
    ${campo("u-marca", "Marca", u.marca)}
    ${campo("u-anio", "Año", u.anio, false, "number")}
    ${campo("u-patente", "Patente (ej. AC 015 YB)", u.patente)}
    ${campo("u-ext", "Vencimiento del matafuego", u.extintorVencimiento, false, "date")}
    <p id="u-err" class="text-red-600 text-xs mt-2 mb-2"></p>
    <div class="flex justify-end gap-2 mt-3">
      <button onclick="cerrarModal('unidad-modal')" class="px-4 py-2 text-sm text-slate-500">Cancelar</button>
      <button onclick="guardarUnidad(${id ? `'${id}'` : "null"})" class="px-4 py-2 text-sm bg-slate-800 text-white rounded-lg font-bold">Guardar</button>
    </div>`);
}

async function guardarUnidad(idOriginal) {
  const id = idOriginal || document.getElementById("u-id").value.trim().toUpperCase();
  const desc = document.getElementById("u-desc").value.trim();
  const marca = document.getElementById("u-marca").value.trim();
  const anio = Number(document.getElementById("u-anio").value) || null;
  const patente = document.getElementById("u-patente").value.trim().toUpperCase();
  const ext = document.getElementById("u-ext").value;
  const err = document.getElementById("u-err");

  if (!id || !desc || !patente) {
    err.textContent = "Completá ID, descripción y patente.";
    return;
  }

  const existente = unidadesNube.find(x => x.id === id);
  if (!idOriginal && existente) {
    err.textContent = `Ya existe una unidad con ID ${id}.`;
    return;
  }

  try {
    await setDoc(doc(db, "vehiculos", id), {
      descripcion: desc,
      marca,
      anio,
      patente,
      extintorVencimiento: ext,
      activo: existente ? existente.activo !== false : true
    }, { merge: true });
    cerrarModal("unidad-modal");
  } catch (e) {
    err.textContent = "No se pudo guardar: " + e.message;
  }
}

// Baja lógica: no se borra, se marca activo: false. Se puede revertir.
async function toggleBaja(id) {
  const u = unidadesNube.find(x => x.id === id);
  if (!u) return;
  const reactivar = u.activo === false;
  const msg = reactivar
    ? `¿Reactivar ${id}?`
    : `¿Dar de baja ${id}? Deja de aparecer para los operarios. Sus registros se conservan.`;
  if (!confirm(msg)) return;
  await updateDoc(doc(db, "vehiculos", id), { activo: reactivar });
}

// ---------- carga inicial y de prueba (solo administrador) ----------

async function cargarIniciales() {
  if (!usuarioAdmin) {
    alert("Debés iniciar sesión como administrador.");
    return;
  }
  try {
    const batch = writeBatch(db);
    LISTADO_INICIAL.forEach(v => {
      batch.set(doc(db, "vehiculos", v.id), {
        descripcion: v.description,
        marca: v.brand,
        anio: v.year,
        patente: v.domain,
        extintorVencimiento: "",
        activo: true
      });
    });
    await batch.commit();
    alert("¡Unidades iniciales cargadas con éxito en Firestore!");
  } catch (e) {
    console.error(e);
    alert("Error al cargar unidades: " + e.message);
  }
}

// ---------- funciones adicionales de administración ----------

function verInstructivoAdmin() {
  mostrarModal("instructivo-modal", `
    <div class="flex justify-between items-center mb-3">
      <h3 class="font-black text-lg text-slate-800">Guía de Carga de Documentos</h3>
      <button onclick="cerrarModal('instructivo-modal'); panelAdmin();" class="text-slate-400 text-2xl px-2">&times;</button>
    </div>
    <div class="space-y-3 text-sm text-slate-700">
      <div class="p-3 bg-blue-50 border border-blue-200 rounded-xl">
        <div class="font-bold text-blue-900 mb-1">1. Subir archivos a Google Drive</div>
        <p class="text-xs text-blue-800">Arrastrar los PDF a la carpeta compartida <b>Flota Documentos</b> en Chrome.</p>
      </div>
      <div class="p-3 bg-slate-50 border border-slate-200 rounded-xl">
        <div class="font-bold text-slate-900 mb-1">2. Nombre sugerido (Convención)</div>
        <code class="block text-xs font-mono bg-white p-2 border rounded my-1 text-slate-800">PATENTE_TIPO_VENCIMIENTO.pdf</code>
        <ul class="text-xs list-disc pl-4 space-y-1 mt-1 text-slate-600">
          <li><b>Ejemplo:</b> <span class="font-mono text-slate-800">KEF062_SEGURO_2027-12-31.pdf</span></li>
          <li><b>Tipos válidos:</b> SEGURO, VTV, CEDULA_VERDE, CREDENCIAL_YPF</li>
          <li><b>Sin vencimiento:</b> Usar 9999-12-31</li>
        </ul>
      </div>
      <div class="p-3 bg-green-50 border border-green-200 rounded-xl">
        <div class="font-bold text-green-900 mb-1">3. Ejecutar el corrector en la PC</div>
        <p class="text-xs text-green-800">Hacer doble clic en <b>CORRECTOR_DOCUMENTOS.bat</b> en el escritorio. Corrige nombres, asigna permisos y actualiza la app al instante.</p>
      </div>
    </div>
    <div class="mt-4 text-right">
      <button onclick="cerrarModal('instructivo-modal'); panelAdmin();" class="px-4 py-2 text-sm bg-slate-800 text-white rounded-lg font-bold">Entendido</button>
    </div>`);
}

function verHistorialAdmin(filtroVehiculoId = "") {
  const historial = (window.state?.history || []);
  const DIAS_CONTROL = [
    ["monday", "Lunes"],
    ["tuesday", "Martes"],
    ["wednesday", "Miércoles"],
    ["thursday", "Jueves"],
    ["friday", "Viernes"],
    ["saturday", "Sábado"],
    ["sunday", "Domingo"]
  ];
  const esc = s => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const opcionesVeh = unidadesNube
    .slice()
    .sort(ordenarPorId)
    .map(u => `<option value="${u.id}" ${filtroVehiculoId === u.id ? "selected" : ""}>${u.id} - ${u.patente} (${u.descripcion})</option>`)
    .join("");

  const filtrados = filtroVehiculoId
    ? historial.filter(h => h.vehicleId === filtroVehiculoId)
    : historial;

  const filas = filtrados.length === 0
    ? `<p class="text-xs text-slate-400 p-4 text-center">No hay registros cargados para esta selección.</p>`
    : filtrados.map(h => {
        const fecha = h.timestamp ? new Date(h.timestamp).toLocaleDateString("es-AR") : (h.weekDate || "—");
        const itemsReportados = Array.isArray(h.reportedItems) ? h.reportedItems : [];
        const fallasDiarias = [];
        const dc = h.dailyChecks || {};
        DIAS_CONTROL.forEach(([key, dia]) => {
          const d = dc[key];
          if (!d) return;
          const nota = d.notes ? ` (${esc(d.notes)})` : "";
          if (d.oil === "MALO") fallasDiarias.push(`${dia}: Aceite en MAL estado${nota}`);
          if (d.water === "MALO") fallasDiarias.push(`${dia}: Agua en MAL estado${nota}`);
        });

        const totalFallas = itemsReportados.length + fallasDiarias.length;
        const detalleLista = [
          ...fallasDiarias.map(txt => `<li>• ${txt}</li>`),
          ...itemsReportados.map(it => `<li>• ${esc(it.label || it.id)}${it.status ? ` <span class="font-bold">(${esc(it.status)})</span>` : ""}</li>`)
        ].join("");

        return `
          <div class="p-3 border border-slate-200 rounded-xl mb-2 text-xs">
            <div class="flex justify-between items-center font-bold text-slate-800 mb-1">
              <span>🚗 ${esc(h.vehicleId)} · ${esc(h.driverName || "Conductor no especificado")}</span>
              <span class="text-slate-500 font-normal">${fecha}</span>
            </div>
            <div class="text-slate-600 flex justify-between">
              <span>Km: ${esc(h.startMileage || "—")} · Tipo: ${esc(h.type || "Semanal")}</span>
              <span class="${totalFallas > 0 ? "text-red-600 font-bold" : "text-green-600 font-bold"}">
                ${totalFallas > 0 ? `⚠️ ${totalFallas} ${totalFallas === 1 ? "falla observada" : "fallas observadas"}` : "✅ Sin fallas"}
              </span>
            </div>
            ${totalFallas > 0 ? `<ul class="mt-1.5 bg-red-50 border border-red-100 p-2 rounded-lg text-red-800 space-y-0.5">${detalleLista}</ul>` : ""}
            ${h.generalObservations ? `<div class="mt-1 bg-slate-50 p-1.5 rounded text-slate-700 italic">"${esc(h.generalObservations)}"</div>` : ""}
          </div>`;
      }).join("");

  mostrarModal("historial-admin-modal", `
    <div class="flex justify-between items-center mb-3">
      <h3 class="font-black text-lg text-slate-800">Historial por Unidad</h3>
      <button onclick="cerrarModal('historial-admin-modal'); panelAdmin();" class="text-slate-400 text-2xl px-2">&times;</button>
    </div>
    <div class="mb-3">
      <label class="block text-xs font-bold text-slate-500 uppercase mb-1">Filtrar por vehículo:</label>
      <select onchange="verHistorialAdmin(this.value)" class="w-full border border-slate-300 p-2.5 rounded-xl text-xs font-medium bg-white">
        <option value="">-- Todos los vehículos (${historial.length} registros) --</option>
        ${opcionesVeh}
      </select>
    </div>
    <div class="max-h-[60vh] overflow-y-auto">
      ${filas}
    </div>
    <div class="mt-4 flex justify-between items-center">
      <button onclick="cerrarModal('historial-admin-modal'); panelAdmin();" class="px-4 py-2 text-xs text-slate-600 font-bold">Volver al panel</button>
    </div>`);
}

function verPuntajesAdmin() {
  const historial = (window.state?.history || []);
  const conduct = {};

  historial.forEach(h => {
    const dni = h.driverDni || "S/D";
    const nombre = h.driverName || "Sin Nombre";
    const key = `${dni}_${nombre}`;
    if (!conduct[key]) {
      conduct[key] = { dni, nombre, reportes: 0, puntos: 0, semanasLimpias: 0 };
    }
    conduct[key].reportes++;
    conduct[key].puntos += (h.creditsAwarded || 0);
    if (h.isCleanWeek) conduct[key].semanasLimpias++;
  });

  const lista = Object.values(conduct).sort((a, b) => b.puntos - a.puntos);

  const filas = lista.length === 0
    ? `<p class="text-xs text-slate-400 p-4 text-center">No hay registros de conductores en el historial.</p>`
    : lista.map((c, i) => `
        <div class="flex items-center justify-between p-3 border border-slate-200 rounded-xl mb-2 text-xs">
          <div class="flex items-center gap-2.5">
            <span class="w-6 h-6 rounded-full ${i === 0 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"} flex items-center justify-center font-bold">${i + 1}</span>
            <div>
              <div class="font-bold text-slate-800 text-sm">${c.nombre}</div>
              <div class="text-slate-500 text-[11px]">DNI: ${c.dni} · ${c.reportes} inspecciones</div>
            </div>
          </div>
          <div class="text-right">
            <div class="text-sm font-black text-amber-600">${c.puntos} pts</div>
            <div class="text-[10px] text-green-600 font-bold">⭐ ${c.semanasLimpias} sem. limpias</div>
          </div>
        </div>`).join("");

  mostrarModal("puntajes-admin-modal", `
    <div class="flex justify-between items-center mb-3">
      <div>
        <h3 class="font-black text-lg text-slate-800">Puntaje por Conductor</h3>
        <p class="text-xs text-slate-500">Créditos acumulados según inspecciones realizadas</p>
      </div>
      <button onclick="cerrarModal('puntajes-admin-modal'); panelAdmin();" class="text-slate-400 text-2xl px-2">&times;</button>
    </div>
    <div class="max-h-[60vh] overflow-y-auto">
      ${filas}
    </div>
    <div class="mt-4 flex justify-between items-center">
      <button onclick="cerrarModal('puntajes-admin-modal'); panelAdmin();" class="px-4 py-2 text-xs text-slate-600 font-bold">Volver al panel</button>
    </div>`);
}

// ---------- informe mensual admin ----------

function verInformeAdmin() {
  const historial = (window.state?.history || []);
  const ahora = new Date();
  const mesDefault = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`;

  const unidades = unidadesNube.slice().sort(ordenarPorId);
  const conductoresMap = new Map();
  historial.forEach(h => {
    const dni = String(h.driverDni || "").trim();
    if (!dni) return;
    if (!conductoresMap.has(dni)) {
      conductoresMap.set(dni, h.driverName || "Sin nombre");
    }
  });
  const conductores = Array.from(conductoresMap.entries()).sort((a, b) => a[1].localeCompare(b[1], "es"));

  const checksUnidades = unidades.map(u => `
    <label class="flex items-center gap-1.5 text-xs p-1 hover:bg-slate-50 rounded cursor-pointer">
      <input type="checkbox" class="inf-unidad" value="${u.id}" onchange="syncCheckTodos('inf-unidad', 'inf-unidades-todas')">
      <span class="font-bold text-slate-700">${u.id}</span>
      <span class="text-slate-500 truncate">${u.patente || ""}</span>
    </label>`).join("");

  const checksConductores = conductores.length === 0
    ? `<p class="text-xs text-slate-400 p-1">Sin conductores registrados.</p>`
    : conductores.map(([dni, nombre]) => `
      <label class="flex items-center gap-1.5 text-xs p-1 hover:bg-slate-50 rounded cursor-pointer">
        <input type="checkbox" class="inf-conductor" value="${dni}" onchange="syncCheckTodos('inf-conductor', 'inf-conductores-todos')">
        <span class="font-bold text-slate-700 truncate">${nombre}</span>
        <span class="text-slate-400">(${dni})</span>
      </label>`).join("");

  mostrarModal("informe-admin-modal", `
    <div class="flex justify-between items-center mb-3">
      <h3 class="font-black text-lg text-slate-800">📊 Informe Mensual (Admin)</h3>
      <button onclick="cerrarModal('informe-admin-modal'); panelAdmin();" class="text-slate-400 text-2xl px-2">&times;</button>
    </div>
    <div class="space-y-3 text-xs">
      <div>
        <label class="block font-bold text-slate-500 uppercase mb-1">Período (Mes / Año)</label>
        <input id="inf-mes" type="month" value="${mesDefault}" class="w-full border border-slate-300 p-2 rounded-xl text-xs bg-white">
      </div>
      <div class="border border-slate-200 rounded-xl p-2.5">
        <label class="flex items-center gap-2 font-bold text-slate-800 pb-1.5 mb-1.5 border-b border-slate-100 cursor-pointer">
          <input id="inf-unidades-todas" type="checkbox" checked onchange="toggleCheckGrupo('inf-unidad', this.checked)">
          <span>Todas las unidades (${unidades.length})</span>
        </label>
        <div class="max-h-32 overflow-y-auto grid grid-cols-2 gap-1">${checksUnidades}</div>
      </div>
      <div class="border border-slate-200 rounded-xl p-2.5">
        <label class="flex items-center gap-2 font-bold text-slate-800 pb-1.5 mb-1.5 border-b border-slate-100 cursor-pointer">
          <input id="inf-conductores-todos" type="checkbox" checked onchange="toggleCheckGrupo('inf-conductor', this.checked)">
          <span>Todos los conductores (${conductores.length})</span>
        </label>
        <div class="max-h-32 overflow-y-auto space-y-0.5">${checksConductores}</div>
      </div>
    </div>
    <div class="mt-4 flex justify-between items-center">
      <button onclick="cerrarModal('informe-admin-modal'); panelAdmin();" class="px-4 py-2 text-xs text-slate-600 font-bold">Volver</button>
      <button onclick="descargarInformeAdmin()" class="px-4 py-2 text-xs bg-green-700 text-white rounded-lg font-bold hover:bg-green-800">📥 Descargar Excel</button>
    </div>`);
}

function toggleCheckGrupo(clase, checked) {
  if (checked) {
    document.querySelectorAll(`.${clase}`).forEach(cb => { cb.checked = false; });
  }
}

function syncCheckTodos(clase, idTodos) {
  const todosCb = document.getElementById(idTodos);
  if (!todosCb) return;
  const algunoMarcado = Array.from(document.querySelectorAll(`.${clase}`)).some(cb => cb.checked);
  todosCb.checked = !algunoMarcado;
}

function descargarInformeAdmin() {
  const mesVal = document.getElementById("inf-mes")?.value;
  if (!mesVal) return alert("Seleccioná un mes.");
  const [anioStr, mesStr] = mesVal.split("-");
  const anio = Number(anioStr);
  const mesIdx = Number(mesStr) - 1;

  const todasUnidades = document.getElementById("inf-unidades-todas")?.checked;
  const selUnidades = Array.from(document.querySelectorAll(".inf-unidad:checked")).map(cb => cb.value);
  if (!todasUnidades && selUnidades.length === 0) return alert("Seleccioná al menos una unidad o 'Todas'.");

  const todosConductores = document.getElementById("inf-conductores-todos")?.checked;
  const selConductores = Array.from(document.querySelectorAll(".inf-conductor:checked")).map(cb => cb.value);
  if (!todosConductores && selConductores.length === 0) return alert("Seleccioná al menos un conductor o 'Todos'.");

  const historial = (window.state?.history || []);
  const filtrados = historial.filter(r => {
    const d = new Date(r.timestamp);
    if (d.getFullYear() !== anio || d.getMonth() !== mesIdx) return false;
    if (!todasUnidades && !selUnidades.includes(r.vehicleId)) return false;
    if (!todosConductores && !selConductores.includes(String(r.driverDni || "").trim())) return false;
    return true;
  });

  if (filtrados.length === 0) return alert("No hay registros para los filtros seleccionados.");

  const totalCreditos = filtrados.reduce((acc, r) => acc + (r.creditsAwarded || 0), 0);
  const summaryData = [
    ["INFORME MENSUAL ADMINISTRADOR - AZILUT S.A."],
    ["PERIODO", `${mesStr}/${anioStr}`],
    ["UNIDADES", todasUnidades ? "Todas" : selUnidades.join(", ")],
    ["CONDUCTORES", todosConductores ? "Todos" : selConductores.join(", ")],
    ["TOTAL REPORTES", filtrados.length],
    ["CRÉDITOS ACUMULADOS", totalCreditos],
    ["FECHA GENERACIÓN", new Date().toLocaleDateString("es-AR")],
    [""]
  ];

  const header = ["FECHA", "VEHÍCULO", "CONDUCTOR", "DNI", "TIPO", "KM", "LUN (A/W)", "MAR (A/W)", "MIE (A/W)", "JUE (A/W)", "VIE (A/W)", "FALLAS", "CRÉDITOS", "OBSERVACIONES"];
  const rows = filtrados.map(r => {
    const d = r.dailyChecks || {};
    const fmtDay = day => {
      if (!d[day]) return "-";
      const oil = d[day].oil === "BUENO" ? "B" : (d[day].oil === "MALO" ? "M" : "-");
      const water = d[day].water === "BUENO" ? "B" : (d[day].water === "MALO" ? "M" : "-");
      return `${oil}/${water}`;
    };
    const fallasDiarias = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
      .reduce((n, k) => n + (d[k]?.oil === "MALO" ? 1 : 0) + (d[k]?.water === "MALO" ? 1 : 0), 0);
    const totalFallas = (r.reportedItems?.length || 0) + fallasDiarias;

    return [
      new Date(r.timestamp).toLocaleDateString("es-AR"),
      r.vehicleId || "",
      r.driverName || "",
      r.driverDni || "",
      r.type || "",
      r.startMileage || "",
      fmtDay("monday"),
      fmtDay("tuesday"),
      fmtDay("wednesday"),
      fmtDay("thursday"),
      fmtDay("friday"),
      totalFallas,
      r.creditsAwarded || 0,
      r.generalObservations || ""
    ];
  });

  const allRows = [...summaryData, header, ...rows];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(allRows);
  if (window.applyAutoWidths) window.applyAutoWidths(ws, allRows);
  XLSX.utils.book_append_sheet(wb, ws, "Informe Admin");
  XLSX.writeFile(wb, `Informe_Admin_${anioStr}_${mesStr}.xlsx`);
}

// ---------- respaldo y restauración en Firestore (solo admin) ----------

async function exportarRespaldoAdmin() {
  try {
    const altasSnap = await getDocs(collection(db, "altas"));
    const altas = {};
    altasSnap.docs.forEach(d => { altas[d.id] = d.data(); });

    const vehiculos = {};
    unidadesNube.forEach(u => {
      const { id, ...rest } = u;
      vehiculos[id] = rest;
    });

    const payload = {
      version: 2,
      fecha: new Date().toISOString(),
      vehiculos,
      documentos: documentosCache,
      historial: window.state?.history || [],
      altas
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `RESPALDO_FLOTA_AZILUT_${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    console.error(e);
    alert("Error al exportar respaldo: " + e.message);
  }
}

async function escribirEnLotes(operaciones) {
  const TAM_LOTE = 450;
  for (let i = 0; i < operaciones.length; i += TAM_LOTE) {
    const batch = writeBatch(db);
    operaciones.slice(i, i + TAM_LOTE).forEach(({ col, id, data }) => {
      batch.set(doc(db, col, id), data, { merge: true });
    });
    await batch.commit();
  }
}

function restaurarRespaldoAdmin(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      const ops = [];
      let resumen = "";

      if (Array.isArray(data)) {
        data.forEach(r => {
          if (r?.vehicleId && r?.weekDate) {
            ops.push({ col: "historial", id: claveRegistro(r), data: r });
          }
        });
        resumen = `${ops.length} registros de historial (formato anterior)`;
      } else if (data && typeof data === "object") {
        const vehs = data.vehiculos || {};
        const docs = data.documentos || {};
        const hist = Array.isArray(data.historial) ? data.historial : [];
        const alts = data.altas || {};

        Object.entries(vehs).forEach(([id, val]) => ops.push({ col: "vehiculos", id, data: val }));
        Object.entries(docs).forEach(([id, val]) => ops.push({ col: "documentos", id, data: val }));
        hist.forEach(r => {
          if (r?.vehicleId && r?.weekDate) ops.push({ col: "historial", id: claveRegistro(r), data: r });
        });
        Object.entries(alts).forEach(([id, val]) => ops.push({ col: "altas", id, data: val }));

        resumen = `${Object.keys(vehs).length} vehículos, ${Object.keys(docs).length} documentos, ${hist.length} registros de historial, ${Object.keys(alts).length} altas`;
      } else {
        return alert("Formato de archivo no válido.");
      }

      if (ops.length === 0) return alert("El archivo no contiene datos para restaurar.");
      if (!confirm(`Se restaurarán en la nube:\n${resumen}\n\n¿Continuar?`)) return;

      await escribirEnLotes(ops);
      alert(`Restauración completada (${ops.length} documentos actualizados en Firebase).`);
      panelAdmin();
    } catch (err) {
      console.error(err);
      alert("Error al restaurar respaldo: " + err.message);
    } finally {
      input.value = "";
    }
  };
  reader.readAsText(file);
}

// ---------- exposición a los onclick del HTML ----------

Object.assign(window, {
  tapTitulo, abrirDocumentos, abrirArchivo, cerrarModal, resumenSemaforoUnidad,
  entrarAdmin, salirAdmin, toggleVerPass, formUnidad, guardarUnidad, toggleBaja,
  cargarIniciales,
  verInstructivoAdmin, verHistorialAdmin, verPuntajesAdmin,
  verInformeAdmin, toggleCheckGrupo, syncCheckTodos, descargarInformeAdmin,
  exportarRespaldoAdmin, restaurarRespaldoAdmin,
  guardarEnNube, crearAlta
});
