'use strict';

/* ═════════════════════════════════════════════════
   CARL'S JR — Ayudante local de impresión
   ═════════════════════════════════════════════════
   - Imprime directamente en la Bixolon compartida.
   - Conserva el endpoint local para pruebas.
   - Revisa Firebase para recibir tickets desde Admira/GitHub Pages.
   ═════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5217;
const TICKETS_DIR = path.join(__dirname, 'tickets-impresos');

const PRINTER_SHARE = 'BIXOLON_TICKETS';
const PRINTER_PATH = `\\\\localhost\\${PRINTER_SHARE}`;

const FIREBASE_DATABASE_URL =
  'https://carlsjr-kiosko-default-rtdb.europe-west1.firebasedatabase.app';

const PRINT_QUEUE_URL =
  `${FIREBASE_DATABASE_URL}/carlsjr/printQueue`;

const POLL_INTERVAL_MS = 1200;

let polling = false;

if (!fs.existsSync(TICKETS_DIR)) {
  fs.mkdirSync(TICKETS_DIR, { recursive: true });
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
}

function safeOrderNum(value) {
  const safe = String(value).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'sin-numero';
}

function printFileSilently(text) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.concat([
      Buffer.from(text + '\n\n\n\n', 'utf8'),
      Buffer.from([0x1D, 0x56, 0x00]),
    ]);

    fs.writeFile(PRINTER_PATH, payload, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function saveTicket(orderNum, text) {
  const filePath = path.join(
    TICKETS_DIR,
    `pedido-${safeOrderNum(orderNum)}.txt`
  );

  await fs.promises.writeFile(filePath, text, 'utf8');
  return filePath;
}

async function saveAndPrint(orderNum, text) {
  let saved = false;
  let filePath = '';

  try {
    filePath = await saveTicket(orderNum, text);
    saved = true;
    console.log(`[print-helper] Guardado ${filePath}`);
  } catch (error) {
    console.warn('[print-helper] Error guardando el ticket:', error);
  }

  await printFileSilently(text);

  console.log(
    `[print-helper] Enviado a la impresora: pedido-${safeOrderNum(orderNum)}`
  );

  return { saved, filePath };
}

async function firebaseRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Firebase respondió ${response.status}: ${responseText || 'sin detalle'}`
    );
  }

  if (!responseText || responseText === 'null') return null;

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

async function updatePrintJob(jobId, changes) {
  const url = `${PRINT_QUEUE_URL}/${encodeURIComponent(jobId)}.json`;

  return firebaseRequest(url, {
    method: 'PATCH',
    body: JSON.stringify(changes)
  });
}

async function processFirebaseJob(jobId, job) {
  if (!job || job.status !== 'pending') return;

  if (
    job.printerShare &&
    job.printerShare !== PRINTER_SHARE
  ) {
    return;
  }

  const orderNum = safeOrderNum(job.orderNum);
  const text = typeof job.text === 'string' ? job.text : '';

  if (!text) {
    await updatePrintJob(jobId, {
      status: 'failed',
      error: 'El ticket está vacío',
      finishedAt: Date.now()
    });
    return;
  }

  await updatePrintJob(jobId, {
    status: 'processing',
    startedAt: Date.now()
  });

  try {
    await saveAndPrint(orderNum, text);

    await updatePrintJob(jobId, {
      status: 'printed',
      printedAt: Date.now(),
      error: null
    });
  } catch (error) {
    console.warn(
      `[print-helper] Error imprimiendo el trabajo ${jobId}:`,
      error
    );

    await updatePrintJob(jobId, {
      status: 'failed',
      error: error.message || 'No se pudo enviar a la impresora',
      finishedAt: Date.now()
    });
  }
}

async function pollFirebaseQueue() {
  if (polling) return;
  polling = true;

  try {
    const jobs = await firebaseRequest(`${PRINT_QUEUE_URL}.json`);

    if (!jobs || typeof jobs !== 'object') return;

    const pendingJobs = Object.entries(jobs)
      .filter(([, job]) => {
        return (
          job &&
          job.status === 'pending' &&
          (!job.printerShare || job.printerShare === PRINTER_SHARE)
        );
      })
      .sort((a, b) => {
        return Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0);
      });

    for (const [jobId, job] of pendingJobs) {
      await processFirebaseJob(jobId, job);
    }
  } catch (error) {
    console.warn('[print-helper] No se pudo consultar Firebase:', error.message);
  } finally {
    polling = false;
  }
}

const server = http.createServer((req, res) => {
  withCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/salud') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8'
    });

    res.end(JSON.stringify({
      ok: true,
      printerShare: PRINTER_SHARE,
      printerPath: PRINTER_PATH,
      firebaseQueue: PRINT_QUEUE_URL
    }));

    return;
  }

  if (req.method === 'POST' && req.url === '/imprimir') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 2_000_000) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      let data;

      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
          ok: false,
          error: 'JSON inválido'
        }));

        return;
      }

      const orderNum = safeOrderNum(data.orderNum);
      const text = typeof data.text === 'string' ? data.text : '';

      if (!text) {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
          ok: false,
          error: 'Falta el texto del ticket'
        }));

        return;
      }

      try {
        const result = await saveAndPrint(orderNum, text);

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
          ok: true,
          saved: result.saved,
          printed: true
        }));
      } catch (error) {
        console.warn('[print-helper] Error al imprimir:', error);
        console.warn(
          `[print-helper] Verifica que la impresora esté compartida como "${PRINTER_SHARE}".`
        );

        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
          ok: false,
          error: 'No se pudo enviar a la impresora'
        }));
      }
    });

    return;
  }

  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8'
  });

  res.end(JSON.stringify({
    ok: false,
    error: 'No encontrado'
  }));
});

server.on('error', error => {
  console.error('[print-helper] No se pudo iniciar:', error);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[print-helper] Escuchando en http://127.0.0.1:${PORT}`);
  console.log(`[print-helper] Impresora esperada: ${PRINTER_PATH}`);
  console.log(`[print-helper] Tickets guardados en: ${TICKETS_DIR}`);
  console.log(`[print-helper] Cola Firebase: ${PRINT_QUEUE_URL}`);

  pollFirebaseQueue();
  setInterval(pollFirebaseQueue, POLL_INTERVAL_MS);
});
