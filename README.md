# WatchRoom

Funkčný prototyp spoločného sledovania bez účtov alebo chatu. Zakladateľ vytvorí miestnosť, vyberie lokálny súbor, priamy URL odkaz na MP4/WebM alebo zdieľa kartu/obrazovku so zvukom. Video vysiela priamo divákom cez WebRTC. Diváci nemôžu ovládať hostiteľov zdroj.

## Spustenie

1. Nainštaluj Node.js 20 alebo novší.
2. V tomto priečinku spusti `npm install`.
3. Spusti `npm start`.
4. Otvor `http://localhost:3000`, klikni **Vytvoriť miestnosť**.
5. Skopíruj odkaz a otvor ho v ďalšom okne/zariadení.
6. Host klikne na **Súbor**, **URL videa** alebo **Karta / obrazovka**.

## Dôležité obmedzenia

- **HTTPS je potrebné** pri vzdialenom použití pre `getDisplayMedia` a väčšinu zabezpečených browser API. `localhost` je výnimka. Použi reverzný proxy (nginx/Caddy) s TLS.
- **Socket.IO a WebRTC**: Socket.IO slúži na signalizáciu; video nejde cez backend. Pre niektoré siete/NAT je potrebný **TURN** server. Doplň jeho `urls`, `username`, `credential` do `rtcConfig` v `public/app.js` pred produkčným použitím.
- Tento prototyp používa **WebRTC mesh**: každý divák dostáva samostatný prenos z hosta. Je vhodný na malé súkromné miestnosti; maximum je 12 divákov, ale skutočná kapacita závisí od uploadu hosta. Pre väčšie miestnosti treba SFU (napr. mediasoup alebo LiveKit).
- URL nie je všeobecný scraper. Fungujú iba **priame odkazy** na videá, ktoré prehliadač podporuje a ich server umožňuje prehrávať cez CORS. Stránky typu Streamtape, DoodStream, Voe, Mixdrop alebo DRM služby spravidla nepôjdu vložiť ako priamy URL — môžeš zvoliť **zdieľanie karty**, pokiaľ to stránka a prehliadač povoľujú.
- Pri zdieľaní celej obrazovky závisí dostupnosť zvuku od prehliadača/OS. Pri karte v Chrome/Edge zaškrtni „Zdieľať zvuk karty“.
- `captureStream()` môže byť obmedzený prehliadačom, CORS alebo kodekom. Pri direct video zdroji je najlepšie použiť aktuálny Chrome/Edge.
- Pri zdieľaní karty host ovláda video **v pôvodnej karte**; Play/Pause vo webovom ovládaní platí pre lokálny video súbor/URL.
- Bez registrácie: host má **tajný token v sessionStorage** v danej karte. Nezdieľaj token ani storage; pozvánka obsahuje len ID miestnosti. Po strate sessionStorage sa hostovská rola nedá obnoviť. Pri odpojení hosta má miestnosť 60 sekúnd na opätovné pripojenie.
- Pre verejnú prevádzku doplň ochranu proti zneužitiu (rate limiting, správu miestností, monitoring, TURN infraštruktúru, vymazávanie opustených izieb).
- Prehrávaj iba obsah, na ktorý máš potrebné oprávnenie.

## Štruktúra

- `server.js`: miestnosti, token moderátora, WebRTC signalizácia
- `public/index.html`: UI
- `public/style.css`: dizajn
- `public/app.js`: WebRTC, video capture, ovládanie


## Ak divák vidí čiernu obrazovku
1. Obnov stránku hosta aj diváka (Ctrl+F5). Host spustí vysielanie znova.
2. Divák klikne na **Spustiť sledovanie**, ak sa zobrazí. Prehliadač môže blokovať autoplay so zvukom.
3. Skúste Chrome/Edge a najprv vysielanie karty so zapnutým zdieľaním zvuku.
4. Otvorte F12 > Console: hľadajte `WebRTC connection` a `ICE connection`. Ak je `failed`, spojenie cez STUN neprejde – produkčné nasadenie potrebuje TURN server so správnymi prihlasovacími údajmi.
5. WebRTC prenos medzi rôznymi sieťami nie je bez TURN servera garantovaný. Hosting Render zabezpečuje signalizáciu, nie video relaying.

Upozornenie: Táto opravná verzia pridáva diagnostiku, možnosť ručného spustenia prehrávača a obmedzené opakovanie spojenia. Neobsahuje TURN server ani jeho prihlasovacie údaje.
