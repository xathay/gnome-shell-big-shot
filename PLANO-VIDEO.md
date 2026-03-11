# Plano de Implementação — Gravação de Vídeo (Big Shot)

## Visão Geral

A extensão Big Shot já possui toda a infraestrutura base para gravação de vídeo
via GNOME Screencast D-Bus service. Este documento detalha o estado atual, os
problemas conhecidos e as melhorias planejadas.

---

## Status Atual

### ✅ Infraestrutura Implementada

| Componente | Descrição | Arquivo |
|---|---|---|
| Detecção GPU | Auto-detect NVIDIA/AMD/Intel via `lspci` | `extension.js` → `detectGpuVendors()` |
| 8 Pipelines GStreamer | CUDA H.264, GL H.264, VAAPI LP, VAAPI, SW GL H.264, SW H.264, SW GL VP8, SW VP8 | `extension.js` → `VIDEO_PIPELINES` |
| Cascade automático | GPU hw → VAAPI → Software com fallback | `extension.js` → `_screencastCommonAsync` |
| Patch ScreencastAsync | Intercepta D-Bus para injetar pipeline customizado | `extension.js` → `_patchScreencast` |
| Botão de vídeo | Force-enable mesmo quando serviço crasheia | `extension.js` → `_forceEnableScreencast` |
| Correção Gst.init | Monkey-patch no launcher do serviço de screencast (GNOME 49 bug) | `/usr/share/gnome-shell/org.gnome.Shell.Screencast` |
| Áudio Desktop + Mic | Toggle buttons com detecção via Gvc.MixerControl | `parts/partaudio.js` |
| Framerate selector | 15/24/30/60 FPS | `parts/partframerate.js` |
| Downsize selector | 100%/75%/50% da resolução | `parts/partdownsize.js` |
| Indicador | Spinner + timer durante gravação | `parts/partindicator.js` |
| Quick Stop | Parada rápida | `parts/partquickstop.js` |

### ✅ Bugs Corrigidos

#### 1. Áudio Desktop/Mic não funciona → RESOLVIDO
**Causa raiz:**
- Faltava `provide-clock=false` no `pulsesrc` — conflito de clock com `pipewiresrc`
- Canais de áudio hardcoded (`channels=2`) em vez de detectar do dispositivo
- Estrutura do `audiomixer` invertida (mixer antes das sources)
- Faltava `latency=100000000` no audiomixer para sincronização
- `GLib.shell_quote()` adicionava aspas extras no nome do device

**Correção:** Reescrita completa do `makeAudioInput()`. Áudio confirmado: `Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, 112 kb/s`.

#### 2. Pipeline de áudio+vídeo com estrutura incorreta → RESOLVIDO
**Causa raiz:** `name=mux` estava num queue ao invés do muxer; MUXERS tinham `! queue` extra.
**Correção:** MUXERS simplificados (`mp4mux fragment-duration=500`, `webmmux`), pipeline reestruturado:
```
video ! queue ! mux. audio ! mux. muxer name=mux
```

#### 3. Property name errado no GNOME 49 → RESOLVIDO
**Causa raiz:** Código usava `_screencastService` que não existe no GNOME 49. O correto é `_screencastProxy`.
**Correção:** Todas as referências atualizadas para `_screencastProxy`.

#### 4. Capsfilter duplicado → RESOLVIDO
**Causa raiz:** O serviço GNOME prepend `capsfilter caps=video/x-raw,max-framerate=F/1` para pipelines customizados. Nossa pipeline também tinha capsfilter. Dois capsfilters não conseguiam linkar (erro `Gst.ParseFlags.FATAL_ERRORS`). Descoberto via `GST_DEBUG=3`.
**Correção:** Capsfilter removido das pipelines sw-memfd; adicionado `videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4` para conversão de formato.

#### 5. Extensão de arquivo `.undefined` → RESOLVIDO
**Causa raiz:** O serviço não fornece `fileExtension` para pipelines customizados → `stem.undefined`.
**Correção:** `fixFilePath` usa o caminho real retornado pelo D-Bus (`result[1]`) e renomeia para `.mp4`.

#### 6. Indicador do painel duplicado → RESOLVIDO
**Causa raiz:** `onPipelineStarting()` era chamado a cada tentativa de pipeline (4x), adicionando spinners duplicados. `onPipelineReady()` nunca era chamado no fallback GNOME.
**Correção:** `onPipelineStarting()` chamado uma vez antes do loop; `onPipelineReady()` chamado no fallback.

#### 7. Screenshot bloqueado durante gravação → RESOLVIDO
**Causa raiz:** `screenshotUI.open()` retornava imediatamente quando `_screencastInProgress` é true.
**Correção:** Patch em `open()` para limpar temporariamente a flag no modo screenshot.

---

## Melhorias Planejadas

### Fase 1 — Estabilização (Prioridade Alta) ✅ CONCLUÍDA

#### 1.1 Validar gravação end-to-end
- [x] Testar gravação sem áudio (só vídeo) — cascade funciona (sw-memfd-h264-openh264)
- [x] Testar gravação com Desktop Audio — Stream AAC 44100Hz stereo confirmado
- [x] Testar gravação com Mic — funciona via pulsesrc + Gvc.MixerControl
- [x] Testar gravação com Desktop + Mic simultaneamente — audiomixer funciona
- [x] Verificar logs com `journalctl --user | grep "Big Shot"` — todas as mensagens corretas
- [ ] Validar em hardware: NVIDIA, AMD, Intel e CPU-only (testado apenas em VM virtio sem GPU)

#### 1.2 Robustez do serviço de screencast
- [x] Pipeline cascade funciona (tenta hw → sw-memfd → sw-gl → GNOME default)
- [ ] Tratar reconexão automática se o serviço crashar
- [x] Log detalhado de qual pipeline foi selecionado e por quê

#### 1.3 Correções adicionais (descobertas durante testes)
- [x] Corrigir `_screencastProxy` (era `_screencastService` no código)
- [x] Remover capsfilter duplicado das pipelines sw-memfd
- [x] Corrigir extensão de arquivo `.undefined` → `.mp4`
- [x] Corrigir indicador do painel (spinner duplicado)
- [x] Permitir screenshot durante gravação (patch em `screenshotUI.open()`)

### Fase 2 — Qualidade de Gravação (Prioridade Média)

#### 2.1 Seletor de qualidade
Inspirado no `big-video-converter`:
- [ ] Adicionar seletor: Alta / Média / Baixa
- [ ] Mapear para bitrates:
  - Alta: 40.000 kbps (HW) / 40.000.000 bps (SW)
  - Média: 20.000 kbps / 20.000.000 bps
  - Baixa: 10.000 kbps / 10.000.000 bps
- [ ] Criar novo Part: `PartQuality`

#### 2.2 Seletor de codec
- [ ] H.264 (padrão, máxima compatibilidade)
- [ ] H.265/HEVC (melhor compressão)
- [ ] VP8/VP9 (WebM, open source)
- [ ] AV1 (futuro, melhor compressão)
- [ ] Adicionar pipelines correspondentes em `VIDEO_PIPELINES`

#### 2.3 Seletor de formato de saída
- [ ] MP4 (padrão)
- [ ] WebM
- [ ] MKV (possível via `matroskamux`)

### Fase 3 — Funcionalidades Avançadas (Prioridade Baixa)

#### 3.1 Pós-processamento com FFmpeg/big-video-converter
- [ ] Após gravação, oferecer re-encoding via `big-video-converter`
  - Conversão de formato (WebM→MP4)
  - Ajuste de qualidade pós-gravação
  - Aplicar filtros (brilho, saturação)
- [ ] Chamar via `Gio.Subprocess` com env vars do big-video-converter:
  ```
  gpu=auto video_quality=high video_encoder=h264 big-video-converter recording.webm
  ```

#### 3.2 Gravação de janela específica
- [ ] Investigar viabilidade — GNOME Screencast D-Bus suporta apenas tela inteira ou área
- [ ] Alternativa: capturar geometria da janela e usar `ScreencastAreaAsync`
- [ ] Tracking de janela se ela mover durante gravação (complexo)

#### 3.3 Overlay durante gravação
- [ ] Desenhar anotações em tempo real durante screencast
- [ ] Requer pipeline com compositor (muito complexo via D-Bus)
- [ ] Alternativa: overlay via Clutter actor sobreposto

#### 3.4 GIF export
- [ ] Conversão pós-gravação de vídeo para GIF animado
- [ ] Via FFmpeg: `ffmpeg -i input.mp4 -vf "fps=10,scale=640:-1" output.gif`
- [ ] Ou via GStreamer com plugin gifenc

---

## Referências Técnicas

### Pipeline GStreamer — Anatomia Real (GNOME 49)

O serviço de screencast do GNOME 49 é um processo D-Bus separado que envolve o pipeline customizado:

```
pipewiresrc path=X do-timestamp=true keepalive-time=1000 resend-last=true   ← Auto-prepended pelo serviço
  ! capsfilter caps=video/x-raw,max-framerate=F/1                            ← Auto-prepended pelo serviço
  ! videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4  ← Nossa pipeline (início)
  ! queue
  ! openh264enc complexity=high bitrate=40000000 ...                          ← Encoder
  ! h264parse
  ! queue
  ! mux.                                                                      ← Conecta vídeo ao muxer
  pulsesrc device=X provide-clock=false                                       ← Áudio (fonte)
  ! capsfilter caps=audio/x-raw,channels=N
  ! audioconvert ! queue ! fdkaacenc ! queue
  ! mux.                                                                      ← Conecta áudio ao muxer
  mp4mux fragment-duration=500 name=mux                                       ← Muxer (DEVE ser o último)
  ! filesink location="path.undefined"                                        ← Auto-appended pelo serviço
```

**IMPORTANTE:** O serviço NÃO fornece `fileExtension` para pipelines customizados. Os arquivos são salvos como `.undefined` e a extensão renomeia para `.mp4` após a gravação.

**IMPORTANTE:** A pipeline customizada NÃO deve incluir `capsfilter` — o serviço já adiciona um. Dois capsfilters causam `FATAL_ERRORS`.

### Detecção de GPU — Paridade com big-video-converter
| Detecção | big-video-converter (bash) | Big Shot (GJS) |
|---|---|---|
| NVIDIA | `grep -i nvidia lspci` | `/nvidia/i.test(lspci)` |
| AMD | `grep -iE 'AMD\|ATI' lspci` | `/\bamd\b\|\bati\b/i.test(lspci)` |
| Intel | `grep -i intel lspci` | `/intel/i.test(lspci)` |
| Fallback | software encoder | VP8/OpenH264 software |

### Encoders — Correspondência
| big-video-converter | Big Shot GStreamer |
|---|---|
| `h264_nvenc` (FFmpeg) | `nvh264enc` (GStreamer) |
| `h264_vaapi` (FFmpeg) | `vaapih264enc` (GStreamer) |
| `libx264` (FFmpeg) | `openh264enc` (GStreamer) |
| `libvpx` (FFmpeg) | `vp8enc` (GStreamer) |
| `fdkaac` (FFmpeg) | `fdkaacenc` (GStreamer) |

---

## Viabilidade

**A gravação de vídeo é altamente viável porque:**

1. A infraestrutura de pipeline cascade com auto-detect de GPU **já está implementada**
2. O padrão é idêntico ao big-video-converter (detectar GPU → tentar HW → fallback software)
3. PipeWire + pulsesrc já funcionam no BigLinux
4. GStreamer no GNOME fornece encoders HW via plugins (gst-plugins-bad para VAAPI/NVENC)
5. Performance de HW encoding é excelente para screencast (< 5% CPU em NVIDIA/AMD)
6. Mesmo o fallback software (OpenH264/VP8 com cpu-used=5) é viável para resoluções até 1080p
