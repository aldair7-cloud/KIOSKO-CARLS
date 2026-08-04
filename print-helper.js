'use strict';

/* ═════════════════════════════════════════════════
   CARL'S JR — Ayudante de impresión de tickets (proceso local)
   ═════════════════════════════════════════════════
   Este proceso debe ejecutarse en el mismo Windows del kiosco.
   Recibe el ticket por HTTP y lo envía directamente a la impresora
   compartida, sin abrir el diálogo de impresión del navegador.
   ═════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5217;
const TICKETS_DIR = path.join(__dirname, 'tickets-impresos');

// Debe coincidir EXACTAMENTE con el nombre compartido de la Bixolon.
const PRINTER_SHARE = 'BIXOLON_TICKETS';
const PRINTER_PATH = `\\\\localhost\\${PRINTER_SHARE}`;

if (!fs.existsSync(TICKETS_DIR)) {
  fs.mkdirSync(TICKETS_DIR, { recursive: true });
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Permite la llamada desde una página HTTPS alojada, por ejemplo GitHub Pages,
  // hacia el servicio local del kiosco cuando el navegador aplica PNA/LNA.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cache-Control', 'no-store');
}

function safeOrderNum(value) {
  const safe = String(value).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'sin-numero';
}

function printFileSilently(text, callback) {
  const payload = Buffer.concat([
    Buffer.from(text + '\n\n\n\n', 'utf8'),
    Buffer.from([0x1D, 0x56, 0x00]), // GS V 0: corte completo
  ]);

  fs.writeFile(PRINTER_PATH, payload, callback);
}

const server = http.createServer((req, res) => {
  withCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/salud') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      printerShare: PRINTER_SHARE,
      printerPath: PRINTER_PATH,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/imprimir') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });

    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
        return;
      }

      const orderNum = safeOrderNum(data.orderNum);
      const text = typeof data.text === 'string' ? data.text : '';

      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Falta el texto del ticket' }));
        return;
      }

      const filePath = path.join(TICKETS_DIR, `pedido-${orderNum}.txt`);

      fs.writeFile(filePath, text, 'utf8', writeError => {
        if (writeError) {
          console.warn('[print-helper] Error guardando el ticket:', writeError);
        } else {
          console.log(`[print-helper] Guardado ${filePath}`);
        }

        printFileSilently(text, printError => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

          if (printError) {
            console.warn('[print-helper] Error al imprimir:', printError);
            console.warn(`[print-helper] Verifica que la impresora esté compartida como "${PRINTER_SHARE}".`);
            res.end(JSON.stringify({
              ok: false,
              saved: !writeError,
              error: 'No se pudo enviar a la impresora',
            }));
            return;
          }

          console.log(`[print-helper] Enviado a la impresora: pedido-${orderNum}`);
          res.end(JSON.stringify({ ok: true, saved: !writeError, printed: true }));
        });
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'No encontrado' }));
});

server.on('error', error => {
  console.error('[print-helper] No se pudo iniciar:', error);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[print-helper] Escuchando en http://127.0.0.1:${PORT}`);
  console.log(`[print-helper] Impresora compartida esperada: ${PRINTER_PATH}`);
  console.log(`[print-helper] Tickets guardados en: ${TICKETS_DIR}`);
});
