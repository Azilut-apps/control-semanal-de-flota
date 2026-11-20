// flota-nube.js
// Paso 3 (borrador): capa nube con Firestore y Authentication.
// Operarios: solo lectura, sin login.
// Administradores: alta, edición y baja lógica de unidades. Acceso oculto (5 toques en el título).
// NO integrado aún en index.html. Se integra cuando lo autorices.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, writeBatch
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

// Semáforo calculado en la app, no guardado.
function semaforo(iso) {
  if (!iso) return { color: "slate", txt: "Sin cargar" };
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const [y, m, d] = iso.split("-").map(Number);
  const dias = Math.round((new Date(y, m - 1, d) - hoy) / 86400000);
  if (dias < 0) return { color: "red", txt: "Vencido" };
  if (dias <= 30) return { color: "amber", txt: `Vence en ${dias} días` };
  return { color: "green", txt: "Vigente" };
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
}, err => console.error("documentos:", err));

onAuthStateChanged(auth, u => { usuarioAdmin = u; });

// ---------- Documentos (operarios) ----------

function abrirDocumentos() {
  if (!state.selectedVehicle) return;
  docVehiculo = state.selectedVehicle;
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
    <input id="adm-pass" type="password" placeholder="Contraseña" class="w-full border border-slate-300 p-3 rounded-xl mb-2">
    <p id="adm-err" class="text-red-600 text-xs mb-2"></p>
    <div class="flex justify-end gap-2">
      <button onclick="cerrarModal('login-modal')" class="px-4 py-2 text-sm text-slate-500">Cancelar</button>
      <button onclick="entrarAdmin()" class="px-4 py-2 text-sm bg-slate-800 text-white rounded-lg font-bold">Entrar</button>
    </div>`);
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
      <button onclick="formUnidad(null)" class="px-4 py-2 text-sm bg-slate-800 text-white rounded-lg font-bold">+ Nueva unidad</button>
      ${unidadesNube.length === 0
        ? `<button onclick="cargarIniciales()" class="px-4 py-2 text-sm border border-slate-300 rounded-lg font-bold">Cargar unidades iniciales</button>`
        : `<button onclick="cargarPrueba()" class="px-4 py-2 text-sm border border-slate-300 rounded-lg font-bold">Cargar documentos de prueba</button>`}
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

// Datos de prueba: fechas ficticias para probar semáforo y botón Ver PDF (sin archivo).
async function cargarPrueba() {
  if (!usuarioAdmin) {
    alert("Debés iniciar sesión como administrador.");
    return;
  }
  const unidadesActivas = unidadesNube.filter(u => u.activo !== false);
  if (unidadesActivas.length === 0) {
    alert("No hay unidades registradas en la base. Hacé clic primero en 'Cargar unidades iniciales'.");
    return;
  }
  try {
    const fechas = ["2026-12-15", "2027-06-30", "2026-11-10", "2027-02-28"];
    const batch = writeBatch(db);
    unidadesActivas.forEach(u => {
      const pat = u.patente.replace(/\s+/g, "").toUpperCase();
      TIPOS_DOC.forEach((t, i) => {
        batch.set(doc(db, "documentos", `${pat}_${t.id}`), {
          patente: pat,
          vehiculoId: u.id,
          tipo: t.id,
          vencimiento: fechas[i],
          archivoNombre: "",
          archivoUrl: "",
          actualizado: new Date().toISOString()
        }, { merge: true });
      });
    });
    await batch.commit();
    alert("¡Documentos de prueba cargados con éxito! Ya podés revisar el botón Documentos.");
  } catch (e) {
    console.error(e);
    alert("Error al cargar documentos de prueba: " + e.message);
  }
}

// ---------- exposición a los onclick del HTML ----------

Object.assign(window, {
  tapTitulo, abrirDocumentos, abrirArchivo, cerrarModal,
  entrarAdmin, salirAdmin, formUnidad, guardarUnidad, toggleBaja,
  cargarIniciales, cargarPrueba
});