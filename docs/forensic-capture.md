# Forensic Web Page Capture

**Status:** rascunho · **Autor:** Leonardo Athayde · **Data:** 2026-05-24
**Componente:** `usr/lib/big-shot/forensic_capture.py` · **Versão alvo:** Big-Shot v1 (GJS) + v2 (Qt6)

## 0 · Resumo executivo

Captura de página web completa para uso pericial/judicial/probatório, inspirada na funcionalidade do **FireShot Pro**. Diferente de um plug-in de navegador, opera **fora do browser**: recarrega a URL em Chromium headless via Playwright e produz um **pacote de evidências** com screenshot full-page, MHTML, HAR, cadeia de certificados TLS, resolução DNS, headers HTTP, cadeia de redirecionamentos e `manifest.json` com SHA-256 de cada artefato. Opcionalmente sela o manifesto com **carimbo de tempo RFC 3161** (FreeTSA por padrão).

Decisão arquitetural: **toda a lógica forense vive em um helper Python standalone**, fora do GJS. Isso garante que a v2 (Qt6/Kirigami via xdg-desktop-portal — ver [RFC-001](RFC-001-port-multi-de-via-xdp.md)) reaproveite o helper **sem reescrever**. A extensão GJS apenas detecta a URL da janela ativa do browser e dispara `Gio.Subprocess`.

**Relação com a [captura rolante](scrolling-capture.md):** a captura rolante (`<Super><Shift>R`) preserva sessão logada e funciona em qualquer app, mas não tem metadado pericial. A forense recarrega de fora e produz prova técnica. Use a rolante para WhatsApp, Telegram, Thunderbird, painéis administrativos; use a forense quando o que importa é a URL pública e a evidência da requisição/resposta HTTP no momento.

## 1 · Não-objetivos

- **Não substitui** o FireShot/plug-in de navegador para captura **com sessão logada** — recarrega de fora, com cookies vazios. Para isso, use a [captura rolante](scrolling-capture.md) na janela do browser.
- **Não valida** a cadeia TLS — apenas **registra** o estado observado no momento da captura, incluindo certificados inválidos ou expirados. A validação é decisão do perito/juiz.
- **Não substitui** Ata Notarial (CC art. 384) nem ata eletrônica do CNJ. Serve como **subsídio técnico** que pode ser **anexado** a esses instrumentos, ou usado em sede administrativa, interna, ou pré-processual.

## 2 · CLI

```
big-shot-forensic-capture --url <URL> [opções]
```

| Flag                    | Padrão                                | Descrição                                              |
| ----------------------- | ------------------------------------- | ------------------------------------------------------ |
| `--url`                 | (obrigatório)                         | URL com esquema (http/https).                          |
| `--output-dir`          | `~/Imagens/BigShot-Forense`           | Diretório pai do bundle.                               |
| `--viewport`            | `1366x768`                            | Tamanho da viewport (`WIDTHxHEIGHT`).                  |
| `--user-agent`          | UA Chrome 127 + sufixo `BigShotForensic` | Override do User-Agent.                              |
| `--timeout`             | `60000` (ms)                          | Timeout de navegação.                                  |
| `--tsa`                 | desligado                             | Solicita carimbo de tempo RFC 3161.                    |
| `--tsa-url`             | `https://freetsa.org/tsr`             | Endpoint TSA.                                          |
| `--no-zip`              | desligado                             | Não empacota em `.zip`.                                |
| `--quiet`               | desligado                             | Suprime logs de progresso no stderr.                   |
| `--tool-version`        | `0.1.0`                               | String de versão gravada no manifesto (set pelo pkg).  |

**Saída no stdout** (parseável pela extensão GJS): JSON com `capture_id`, `bundle_dir`, `zip_path`, `manifest_sha256`, `url_final`, `http_status`. Exit code: `0` ok · `2` erro de uso/dependência · `130` interrompido.

## 3 · Layout do bundle

```
~/Imagens/BigShot-Forense/
└── 20260524-143022Z_exemplo.com.br/
    ├── manifest.json            ← URL, timestamps, hashes, env (TUDO)
    ├── manifest.sha256          ← hash do manifesto (cópia humana)
    ├── fullpage.png             ← screenshot full-page
    ├── viewport.png             ← screenshot da viewport inicial
    ├── page.mhtml               ← MHTML com recursos embarcados
    ├── rendered.html            ← HTML pós-execução de JS
    ├── network.har              ← HAR completo do tráfego
    ├── headers.json             ← headers req/resp + cadeia de redirects
    ├── certificate-chain.pem    ← cadeia TLS (se https)
    ├── certificate-info.json    ← metadados parseados (subject, issuer, fingerprint, validade)
    ├── dns.json                 ← resolução DNS (A/AAAA)
    ├── console.log              ← console do browser
    ├── env.json                 ← hostname, user, OS, kernel, UA, TZ, versão Playwright
    └── timestamp.tsr            ← (opcional, --tsa) token RFC 3161
    └── timestamp.info           ← (opcional, --tsa) metadados do carimbo
20260524-143022Z_exemplo.com.br.zip      ← bundle zipado (opcional)
20260524-143022Z_exemplo.com.br.zip.sha256
```

## 4 · Schema do `manifest.json`

```json
{
  "format_version": 1,
  "tool": { "name": "big-shot-forensic-capture", "version": "0.1.0" },
  "capture_id": "uuid4",
  "url_requested": "https://exemplo.com.br/pagina",
  "url_final": "https://www.exemplo.com.br/pagina",
  "redirect_chain": [
    { "url": "...", "status": 301, "location": "..." }
  ],
  "http_status": 200,
  "timestamps": {
    "requested_at_utc": "2026-05-24T14:30:22.123456+00:00",
    "started_at_utc":   "2026-05-24T14:30:22.456789+00:00",
    "finished_at_utc":  "2026-05-24T14:30:28.789012+00:00",
    "duration_seconds": 6.332
  },
  "network": {
    "dns": { "host": "...", "a": ["..."], "aaaa": ["..."], "error": null },
    "peer_ip": "203.0.113.10"
  },
  "tls": {
    "host": "www.exemplo.com.br",
    "port": 443,
    "peer_ip": "203.0.113.10",
    "leaf": {
      "subject": "CN=www.exemplo.com.br",
      "issuer": "CN=Let's Encrypt R3,O=Let's Encrypt,C=US",
      "fingerprint_sha256": "ab12...",
      "not_before_utc": "...",
      "not_after_utc":  "...",
      "serial_number": "0a1b...",
      "signature_algorithm": "sha256WithRSAEncryption"
    },
    "chain_length": 3,
    "error": null
  },
  "environment": {
    "hostname": "...", "user": "...",
    "os": { "system": "Linux", "release": "7.0.9-1-cachyos", ... },
    "playwright_version": "1.49.0",
    "user_agent": "...",
    "viewport": { "width": 1366, "height": 768 },
    "tz": "BRT", "tz_offset": -10800.0
  },
  "artifacts": {
    "fullpage.png": { "sha256": "...", "size": 234567 },
    "page.mhtml":   { "sha256": "...", "size": 891234 },
    ...
  }
}
```

## 5 · Verificação por terceiros

**Conferir integridade dos artefatos:**

```sh
cd 20260524-143022Z_exemplo.com.br/
jq -r '.artifacts | to_entries[] | "\(.value.sha256)  \(.key)"' manifest.json | sha256sum -c
```

**Conferir hash do manifesto:**

```sh
sha256sum -c manifest.sha256
```

**Verificar o carimbo RFC 3161** (se `--tsa` foi usado):

```sh
# baixar certificados da TSA (uma vez)
curl -O https://freetsa.org/files/tsa.crt
curl -O https://freetsa.org/files/cacert.pem

openssl ts -verify \
  -data manifest.json \
  -in   timestamp.tsr \
  -CAfile cacert.pem \
  -untrusted tsa.crt
# → "Verification: OK" + data/hora UTC do carimbo
```

**Reproduzir o MHTML em qualquer Chromium:** `chromium page.mhtml` (Wayland ou X11).

## 6 · Boas práticas para uso processual

1. **Capture com `--tsa` sempre que possível.** O selo da TSA é assinatura digital de uma terceira parte confiável sobre o hash do manifesto; sem ele, a data e o conteúdo dependem da palavra do operador.
2. **Capture imediatamente após o fato.** Conteúdo dinâmico pode mudar em segundos.
3. **Não edite o bundle.** Qualquer alteração quebra os hashes — o que é, do ponto de vista pericial, exatamente o comportamento desejado.
4. **Anexe o bundle inteiro ao processo (`.zip`)**, não apenas screenshots. A defesa pode (e deve) auditar HAR, certificados e DNS.
5. **Para captura de área logada/com sessão**, hoje use FireShot Pro ou print + ata notarial — o helper recarrega de fora. Companion extension de navegador está no backlog.
6. **Para "site inteiro" (múltiplas páginas)**, faça múltiplas execuções. Crawling automatizado é fora de escopo (e legalmente sensível — `robots.txt`, ToS).

## 7 · Dependências

- `python-playwright` + `chromium` instalado via `playwright install chromium` (ou via pacote da distro).
- `python-cryptography` (recomendado) — sem ele, certificados são reportados apenas pelo fingerprint.
- `openssl` + `curl` — só necessários para `--tsa`.

Em BigLinux/CachyOS o pacote `big-shot` declara essas como `optdepends`. A primeira execução sem dependências mostra mensagem clara no stderr.

## 8 · Integração com a extensão GJS

A extensão (v1) adiciona ao toolbar uma ação **"Capturar página web (forense)"** que:

1. Tenta detectar a URL da janela ativa (heurísticas por título de janela + WM_CLASS para Firefox/Chromium/Brave/Edge/Vivaldi).
2. Abre modal pedindo confirmação/edição da URL e flags (`--tsa`).
3. Dispara o helper via `Gio.Subprocess` (assíncrono) com notificação de progresso.
4. Ao concluir, parseia o JSON do stdout e abre o diretório em Files (Nautilus/Dolphin).

Detalhes da implementação: `usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/parts/partforensic.js`.

## 9 · Roadmap

- **v0.1** (esta versão) — CLI standalone, bundle completo, TSA opcional.
- **v0.2** — wiring na toolbar GJS, detecção de URL via AT-SPI.
- **v0.3** — modo "captura múltipla" (lista de URLs num arquivo).
- **v0.4** — companion extension de navegador para capturar **sessão atual** (cookies + viewport real).
- **v1.0** — port para v2 (Qt6/Kirigami) usando o mesmo helper.
