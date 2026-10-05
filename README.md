# Claude Bridge per Thunderbird

Estensione + server MCP locale: permette a Claude di leggere e cercare le mail di Thunderbird, preparare bozze/risposte/inoltri, sistemare etichette, spostare e cestinare.

**Mai invio diretto** (le mail si inviano a mano dalla finestra di scrittura) e **mai cancellazione permanente** (solo Cestino, con conferma).

```
Claude <-stdio/MCP-> server.py <-HTTP 127.0.0.1 + token-> estensione in Thunderbird
```

## Installazione

1. Server MCP (una volta):
   ```
   claude mcp add thunderbird -- python C:\Users\boris\Documents\AI\ThunderbirdBridge\server.py
   ```
2. Estensione: scarica `claude-bridge.xpi` dall'ultima [release](../../releases/latest) e installala da
   Strumenti -> Componenti aggiuntivi -> ingranaggio -> Installa da file.
3. Opzioni dell'estensione: incolla il token da `%USERPROFILE%\.thunderbird-bridge\token`.

## Aggiornamento automatico

Il `manifest.json` contiene un `update_url` che punta a `updates.json` in questo repository.
A ogni push su `main` che tocca `extension/`, la GitHub Action `release.yml`:

1. imposta la versione `1.0.<n. esecuzione>`;
2. costruisce l'XPI e lo pubblica come release;
3. aggiorna `updates.json` (versione, link, hash SHA-256).

Thunderbird controlla `updates.json` da solo (circa una volta al giorno; Strumenti -> Componenti aggiuntivi ->
ingranaggio -> "Cerca aggiornamenti" per forzarlo) e installa la nuova versione.

### Firma

Thunderbird "release" di solito accetta solo XPI **firmati**. L'Action firma da sola se nei secrets del repo
ci sono `ATN_JWT_ISSUER` e `ATN_JWT_SECRET` (chiavi API da addons.thunderbird.net -> Developer Hub -> API keys).
Senza chiavi pubblica un XPI non firmato, che si installa solo se `xpinstall.signatures.required` e' `false`
(Config Editor) o come componente temporaneo.

Il server (`server.py`) non si aggiorna da solo: `git pull` nella cartella.

## Sviluppo

`python build.py` crea `claude-bridge.xpi` locale.
