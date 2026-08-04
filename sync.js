'use strict';

// ══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN FIREBASE
//  Sincroniza kiosco ↔ KDS ↔ cliente y transporta la cola de impresión.
// ══════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAhb2aE8Zg6hR-J-tsUBHTCsbzI1Wn8eeI",
  authDomain: "carlsjr-kiosko.firebaseapp.com",
  databaseURL: "https://carlsjr-kiosko-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "carlsjr-kiosko",
  storageBucket: "carlsjr-kiosko.firebasestorage.app",
  messagingSenderId: "254893634722",
  appId: "1:254893634722:web:098aee72f81d10db7e93fb"
};

const LS_ORDERS = 'cj-kds-orders';
const LS_NUM    = 'cj-order-num';
const FB_PATH   = 'carlsjr';

const CJSync = (function () {
  let db       = null;
  let ready    = false;
  let initDone = false;

  /* ── Init ── */
  function _init() {
    if (initDone) return;
    initDone = true;

    if (!FIREBASE_CONFIG || typeof firebase === 'undefined') return;

    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.database();
      ready = true;
    } catch (e) {
      console.warn('[CJSync] Firebase init error:', e);
    }
  }

  /* ── Guardar pedidos ── */
  function saveOrders(orders) {
    _init();

    try {
      localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
    } catch (_) {}

    if (!ready) return;

    db.ref(FB_PATH + '/orders')
      .set({ data: JSON.stringify(orders), ts: Date.now() })
      .catch(e => console.warn('[CJSync] saveOrders error:', e));
  }

  /* ── Número de pedido ── */
  function nextOrderNum(cb) {
    _init();

    if (!ready) {
      const n = (parseInt(localStorage.getItem(LS_NUM) || '0', 10) % 200) + 1;
      localStorage.setItem(LS_NUM, String(n));
      cb(n);
      return;
    }

    db.ref(FB_PATH + '/orderNum').transaction(current => {
      return ((current || 0) % 200) + 1;
    }).then(result => {
      const n = result.snapshot.val();
      localStorage.setItem(LS_NUM, String(n));
      cb(n);
    }).catch(() => {
      const n = (parseInt(localStorage.getItem(LS_NUM) || '0', 10) % 200) + 1;
      localStorage.setItem(LS_NUM, String(n));
      cb(n);
    });
  }

  /* ── Escuchar cambios en tiempo real ── */
  function onOrdersChange(callback) {
    _init();
    if (!ready) return false;

    db.ref(FB_PATH + '/orders').on('value', snap => {
      try {
        const val = snap.val();
        if (!val) return;

        const orders = JSON.parse(val.data || '[]');
        localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
        callback(orders);
      } catch (e) {
        console.warn('[CJSync] onOrdersChange parse error:', e);
      }
    });

    return true;
  }

  function isEnabled() {
    _init();
    return ready;
  }

  /* ── Reiniciar todo ── */
  function resetAll() {
    _init();

    try {
      localStorage.removeItem(LS_ORDERS);
      localStorage.removeItem(LS_NUM);
    } catch (_) {}

    if (!ready) return Promise.resolve();

    return Promise.all([
      db.ref(FB_PATH + '/orders')
        .set({ data: JSON.stringify([]), ts: Date.now() })
        .catch(e => console.warn('[CJSync] resetAll orders error:', e)),
      db.ref(FB_PATH + '/orderNum')
        .set(0)
        .catch(e => console.warn('[CJSync] resetAll orderNum error:', e)),
    ]);
  }

  /* ── Pedidos activos ── */
  const ACTIVE_STATUS = ['pending', 'preparing', 'rival_preparing', 'ready'];
  const READY_MAX_MS   = 8 * 60 * 1000;
  const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

  function activeOrders(orders) {
    if (!Array.isArray(orders)) return [];

    const now = Date.now();

    return orders.filter(o => {
      if (!o || typeof o !== 'object') return false;

      const id = Number(o.id);
      if (!Number.isInteger(id) || id <= 0) return false;
      if (!ACTIVE_STATUS.includes(o.status)) return false;

      const ts = Number(o.timestamp) || 0;
      if (ts && now - ts > SESSION_MAX_MS) return false;

      if (
        o.status === 'ready' &&
        now - (Number(o.readyAt) || ts) > READY_MAX_MS
      ) {
        return false;
      }

      return true;
    });
  }

  /* ── Añadir pedido sin pisar otros dispositivos ── */
  function addOrder(order, cb) {
    _init();

    const merge = list => {
      const clean = activeOrders(list);
      const dup = clean.some(
        o => Number(o.id) === Number(order.id) &&
             o.timestamp === order.timestamp
      );

      return dup ? clean : clean.concat([order]);
    };

    if (!ready) {
      let list = [];

      try {
        list = JSON.parse(localStorage.getItem(LS_ORDERS) || '[]');
      } catch (_) {}

      const merged = merge(list);
      saveOrders(merged);

      if (cb) cb(merged);
      return;
    }

    db.ref(FB_PATH + '/orders').transaction(current => {
      let list = [];

      try {
        list = JSON.parse((current && current.data) || '[]');
      } catch (_) {}

      return {
        data: JSON.stringify(merge(list)),
        ts: Date.now()
      };
    }).then(result => {
      const val = result.snapshot.val();
      let list = [];

      try {
        list = JSON.parse((val && val.data) || '[]');
      } catch (_) {}

      try {
        localStorage.setItem(LS_ORDERS, JSON.stringify(list));
      } catch (_) {}

      if (cb) cb(list);
    }).catch(e => {
      console.warn('[CJSync] addOrder error:', e);

      let list = [];

      try {
        list = JSON.parse(localStorage.getItem(LS_ORDERS) || '[]');
      } catch (_) {}

      const merged = merge(list);
      saveOrders(merged);

      if (cb) cb(merged);
    });
  }

  /* ── Cola remota de impresión ──
     La página pública escribe el ticket en Firebase.
     El ayudante local de Windows lo recoge, imprime y cambia su estado. */
  function queuePrint(orderNum, text) {
    _init();

    return new Promise((resolve, reject) => {
      if (!ready) {
        reject(new Error('Firebase no está disponible'));
        return;
      }

      if (typeof text !== 'string' || !text) {
        reject(new Error('El ticket está vacío'));
        return;
      }

      const jobRef = db.ref(FB_PATH + '/printQueue').push();
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        jobRef.off();
        reject(new Error('La impresora no confirmó el ticket a tiempo'));
      }, 30000);

      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        jobRef.off();

        if (error) {
          reject(error);
        } else {
          resolve(value);
          setTimeout(() => {
            jobRef.remove().catch(() => {});
          }, 5000);
        }
      };

      jobRef.on('value', snap => {
        const job = snap.val();
        if (!job) return;

        if (job.status === 'printed') {
          finish(null, job);
        } else if (job.status === 'failed') {
          finish(new Error(job.error || 'La impresora reportó un error'));
        }
      });

      jobRef.set({
        orderNum: String(orderNum),
        text,
        status: 'pending',
        printerShare: 'BIXOLON_TICKETS',
        createdAt: firebase.database.ServerValue.TIMESTAMP
      }).catch(error => {
        finish(error);
      });
    });
  }

  return {
    saveOrders,
    addOrder,
    nextOrderNum,
    onOrdersChange,
    isEnabled,
    resetAll,
    activeOrders,
    queuePrint
  };
})();
// ── Reglas de Realtime Database recomendadas (modo demo) ──
// {
//   "rules": {
//     ".read":  true,
//     ".write": true
//   }
// }
// ─────────────────────────────────────────────────────────────

const LS_ORDERS = 'cj-kds-orders';
const LS_NUM    = 'cj-order-num';
const FB_PATH   = 'carlsjr';

const CJSync = (function () {
  let db       = null;
  let ready    = false;
  let initDone = false;

  /* ── Init ── */
  function _init() {
    if (initDone) return;
    initDone = true;
    if (!FIREBASE_CONFIG || typeof firebase === 'undefined') return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.database();
      ready = true;
    } catch (e) {
      console.warn('[CJSync] Firebase init error:', e);
    }
  }

  /* ── Guardar pedidos ── */
  function saveOrders(orders) {
    _init();
    // Siempre persistir en localStorage como caché local
    try { localStorage.setItem(LS_ORDERS, JSON.stringify(orders)); } catch (_) {}
    if (!ready) return;
    db.ref(FB_PATH + '/orders')
      .set({ data: JSON.stringify(orders), ts: Date.now() })
      .catch(e => console.warn('[CJSync] saveOrders error:', e));
  }

  /* ── Número de pedido (transacción atómica cross-device) ── */
  function nextOrderNum(cb) {
    _init();
    if (!ready) {
      // Fallback local
      const n = (parseInt(localStorage.getItem(LS_NUM) || '0', 10) % 200) + 1;
      localStorage.setItem(LS_NUM, String(n));
      cb(n);
      return;
    }
    db.ref(FB_PATH + '/orderNum').transaction(current => {
      return ((current || 0) % 200) + 1;
    }).then(result => {
      const n = result.snapshot.val();
      localStorage.setItem(LS_NUM, String(n));
      cb(n);
    }).catch(() => {
      // Fallback local si la transacción falla
      const n = (parseInt(localStorage.getItem(LS_NUM) || '0', 10) % 200) + 1;
      localStorage.setItem(LS_NUM, String(n));
      cb(n);
    });
  }

  /* ── Escuchar cambios en tiempo real ── */
  function onOrdersChange(callback) {
    _init();
    if (!ready) return false;
    db.ref(FB_PATH + '/orders').on('value', snap => {
      try {
        const val = snap.val();
        if (!val) return;
        const orders = JSON.parse(val.data || '[]');
        // Mantener localStorage sincronizado
        localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
        callback(orders);
      } catch (e) {
        console.warn('[CJSync] onOrdersChange parse error:', e);
      }
    });
    return true;
  }

  /* ── ¿Firebase disponible? ── */
  function isEnabled() {
    _init();
    return ready;
  }

  /* ── Reiniciar todo (fin de jornada): borra pedidos y contador, local y remoto ──
     Devuelve una Promise: hay que esperarla antes de recargar la página, si no
     la navegación cancela la escritura a Firebase a mitad de camino y otros
     dispositivos (kiosco, pantalla de clientes) nunca reciben el reset. */
  function resetAll() {
    _init();
    try {
      localStorage.removeItem(LS_ORDERS);
      localStorage.removeItem(LS_NUM);
    } catch (_) {}
    if (!ready) return Promise.resolve();
    return Promise.all([
      db.ref(FB_PATH + '/orders').set({ data: JSON.stringify([]), ts: Date.now() })
        .catch(e => console.warn('[CJSync] resetAll orders error:', e)),
      db.ref(FB_PATH + '/orderNum').set(0)
        .catch(e => console.warn('[CJSync] resetAll orderNum error:', e)),
    ]);
  }

  /* ── Pedidos activos (INC-10 / INC-14) ──
     Descarta lo que nunca debería llegar a pantalla:
       · identificadores no numéricos (pedidos de versiones antiguas)
       · estados desconocidos o ya finalizados
       · pedidos "listos" con más de 8 minutos
       · pedidos bloqueados de sesiones anteriores (más de 12 h) */
  const ACTIVE_STATUS = ['pending', 'preparing', 'rival_preparing', 'ready'];
  const READY_MAX_MS   = 8 * 60 * 1000;
  const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

  function activeOrders(orders) {
    if (!Array.isArray(orders)) return [];
    const now = Date.now();
    return orders.filter(o => {
      if (!o || typeof o !== 'object') return false;
      const id = Number(o.id);
      if (!Number.isInteger(id) || id <= 0) return false;
      if (!ACTIVE_STATUS.includes(o.status)) return false;
      const ts = Number(o.timestamp) || 0;
      if (ts && now - ts > SESSION_MAX_MS) return false;
      if (o.status === 'ready' && now - (Number(o.readyAt) || ts) > READY_MAX_MS) return false;
      return true;
    });
  }

  /* ── Añadir un pedido sin pisar lo que hayan hecho otros dispositivos ──
     Antes el kiosco leía su copia local de pedidos, le añadía el nuevo y
     guardaba TODO el array. Si esa copia estaba desfasada (típico al abrir
     la URL desde la app de Admira, que es otro contexto de navegador),
     volvían a aparecer pedidos que el KDS ya había dado por listos.
     Con una transacción se parte siempre de la lista real del servidor. */
  function addOrder(order, cb) {
    _init();

    const merge = (list) => {
      const clean = activeOrders(list);
      const dup = clean.some(o => Number(o.id) === Number(order.id) && o.timestamp === order.timestamp);
      return dup ? clean : clean.concat([order]);
    };

    if (!ready) {
      let list = [];
      try { list = JSON.parse(localStorage.getItem(LS_ORDERS) || '[]'); } catch (_) {}
      const merged = merge(list);
      saveOrders(merged);
      if (cb) cb(merged);
      return;
    }

    db.ref(FB_PATH + '/orders').transaction(current => {
      let list = [];
      try { list = JSON.parse((current && current.data) || '[]'); } catch (_) {}
      return { data: JSON.stringify(merge(list)), ts: Date.now() };
    }).then(result => {
      const val = result.snapshot.val();
      let list = [];
      try { list = JSON.parse((val && val.data) || '[]'); } catch (_) {}
      try { localStorage.setItem(LS_ORDERS, JSON.stringify(list)); } catch (_) {}
      if (cb) cb(list);
    }).catch(e => {
      console.warn('[CJSync] addOrder error:', e);
      let list = [];
      try { list = JSON.parse(localStorage.getItem(LS_ORDERS) || '[]'); } catch (_) {}
      const merged = merge(list);
      saveOrders(merged);
      if (cb) cb(merged);
    });
  }

  return { saveOrders, addOrder, nextOrderNum, onOrdersChange, isEnabled, resetAll, activeOrders };
})();
