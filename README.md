# Kiosco Carl’s Jr.

Kiosco táctil para la selección de productos y generación de pedidos de Carl’s Jr.

La interfaz está pensada para mostrarse en una pantalla de cartelería digital. El cliente selecciona productos, personaliza su pedido y, al finalizar, puede generar e imprimir su ticket.

## Impresión de tickets

La web se carga desde GitHub Pages, pero la impresión se realiza localmente en el PC del kiosco.

## Flujo de impresión:
Web del kiosco → print-helper.js local → impresora compartida TICKETS → Epson TM-m30II


## Inicio automático del helper de impresión
El archivo abrir-kiosco.bat inicia el helper local de impresión. Debe ejecutarse automáticamente al iniciar sesión en Windows.

Pulsa Win + R.

Escribe:

shell:startup

En la carpeta que se abre, crea un acceso directo a:

C:\Users\Admin\Documents\Kiosco-Carl-s-Jr-main\abrir-kiosco.bat

No copies el archivo .bat a la carpeta de inicio; crea solamente un acceso directo.
