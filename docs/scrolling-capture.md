# Scrolling Capture (scroll-and-stitch)

**Status:** rascunho · **Autor:** Leonardo Athayde · **Data:** 2026-05-24
**Componente:** `parts/partscroll.js` · **Versão alvo:** Big-Shot v1 (GJS) · portar para v2 (Qt6)

## 0 · Resumo executivo

Captura uma **área rolável** (janela inteira em foco, na primeira versão) sintetizando eventos de scroll e costurando os frames num PNG único e altão. Funciona em **qualquer aplicação rolável** — browser, WhatsApp/Telegram Desktop, Thunderbird/Evolution, leitores de PDF, terminais com scrollback, painéis administrativos, dashboards. Inspirado em ShareX, Picpick e captura rolante do macOS.

Diferente da [captura forense](forensic-capture.md), que recarrega URL em Chromium headless: aqui o estado **visto pelo usuário** é preservado (login, scroll position de chats com mídia carregada, conversas com áudios reproduzidos, etc).

## 1 · Não-objetivos

- **Não detecta lazy-load infinito** (Twitter/Instagram feed) — para no limite de segurança (60 frames ou 45 s).
- **Não captura região arbitrária** nesta versão — só janela em foco. Seleção de região fica para v0.2 (integração com o seletor nativo do Mutter).
- **Não decide sobre headers/footers fixos** automaticamente — eles aparecerão duplicados nos frames intermediários. Workaround manual: rolar a janela até esconder o header antes de acionar. Detecção automática fica para v0.2.

## 2 · Como usar

1. Foque a janela cujo conteúdo você quer capturar (browser, WhatsApp, Telegram, Thunderbird, etc).
2. **Pressione `<Super><Shift>R`** (configurável em `org.gnome.shell.extensions.big-shot scrolling-capture`).
3. Big-Shot move o cursor para o centro da janela, captura, sintetiza scroll-down repetidamente, e para automaticamente quando dois frames consecutivos forem idênticos (= fim do conteúdo) ou ao atingir o limite de segurança.
4. Notificação aparece com **"Abrir"** e **"Copiar caminho"** — PNG salvo em `~/Imagens/BigShot/scroll-AAAA-MM-DD_HH-MM-SS.png`.

## 3 · Algoritmo

```
0. Move o ponteiro para o centro da região (para o scroll cair na janela certa)
1. captura frame F₀
2. para i = 1 .. maxFrames:
     sintetiza N ticks de scroll-down
     espera scrollSettleMs (default 150 ms — tempo do app redesenhar)
     captura Fᵢ
     overlap, end = findVerticalOverlap(Fᵢ₋₁, Fᵢ)
     se end: para
     senão: append Fᵢ[overlap .. H] ao canvas
3. stitchFrames produz o PNG final
4. salva
```

### 3.1 Detecção de overlap

Para cada candidato `k` em `[minOverlapRows .. overlapSearchRows]`:

- Compara as últimas `k` linhas de `Fᵢ₋₁` com as primeiras `k` linhas de `Fᵢ`.
- Calcula MAD (mean absolute difference) por canal R/G/B, amostrando 1 a cada 4 pixels (para velocidade — ainda robusto).
- Escolhe `k` com menor MAD.
- `similarity = 1 − MAD/255`.

Se `similarity ≥ endOfContentMatch (0.995)` **e** o overlap cobre quase todo o frame, declara fim-de-conteúdo (atalho: comparação byte-a-byte de frames inteiros idênticos detecta o mesmo caso instantaneamente).

### 3.2 Parâmetros padrão (em [`partscroll.js`](../usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/parts/partscroll.js))

| Parâmetro            | Padrão  | Comentário                                                |
| -------------------- | ------- | --------------------------------------------------------- |
| `maxFrames`          | 60      | trava de segurança — máx PNGs intermediários              |
| `totalTimeoutMs`     | 45 000  | trava de segurança em tempo total                         |
| `scrollSettleMs`     | 150     | tempo após scroll para o app redesenhar                   |
| `scrollAmount`       | 5       | ticks discretos de scroll por iteração (≈ 5 notches)      |
| `overlapSearchRows`  | 200     | quantas linhas buscar para overlap (limite superior de k) |
| `minOverlapRows`     | 4       | abaixo disso = "sem overlap" (heurística contra ruído)    |
| `endOfContentMatch`  | 0.995   | similaridade mínima para declarar fim do conteúdo         |

## 4 · APIs do GNOME usadas

| API                                              | Função                              | Risco de quebra entre versões      |
| ------------------------------------------------ | ----------------------------------- | ---------------------------------- |
| `Shell.Screenshot.screenshot_area()`             | captura região (PNG → stream)       | estável (GNOME 40+)                |
| `GdkPixbuf.Pixbuf.new_from_stream()`             | decodifica para acesso a pixels     | estável                            |
| `Clutter.Seat.create_virtual_device(POINTER)`    | cria dispositivo virtual de mouse   | estável (X11+Wayland)              |
| `vdev.notify_absolute_motion()`                  | move ponteiro                       | estável                            |
| `vdev.notify_discrete_scroll()`                  | scroll discreto                     | renomeada em algumas builds — fallback para `notify_scroll_discrete` |
| `global.display.get_focus_window()`              | janela em foco                      | estável                            |
| `Main.wm.addKeybinding()`                        | registra keybinding                 | estável                            |

## 5 · Conhecidos & próximos passos

**v0.1 (esta versão) — engine + keybinding:**
- Captura janela inteira em foco
- Auto-detecta fim de conteúdo
- Saída em `~/Imagens/BigShot/scroll-*.png`
- ⚠️ Mover ponteiro pode atrapalhar o usuário durante a captura — em v0.2, restaurar posição do cursor ao final.

**v0.2 — integração no toolbar de seleção:**
- Toggle "📜 Captura rolante" na UI nativa do Mutter, antes da seleção de região/janela.
- Restaurar cursor.
- Detecção de header fixo (comparar topo dos primeiros 2-3 frames; se idênticos, marcar como header e excluir do stitch).

**v0.3 — região arbitrária:**
- Seleção retangular dentro de janela rolável (útil para capturar só o painel central de um app com sidebar).

**v0.4 — direção horizontal:**
- Para tabelas largas e linhas do tempo.

**v1.0 — port para v2 Qt6:**
- Engine vira C++ puro com QImage/QPainter; mesmo algoritmo.

## 6 · Limitações inerentes

| Cenário                          | Comportamento                                  | Por quê                                            |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Feed infinito (Twitter, IG)      | para no limite de segurança                    | sem fim natural                                    |
| Header/footer fixos              | duplicam em cada frame intermediário           | detecção automática planejada para v0.2            |
| Scroll com animação easing       | overlap pode falhar em alguns frames           | mitigado por scrollSettleMs maior                  |
| Conteúdo dinâmico (vídeo tocando, GIF) | dessincroniza overlap → linhas mortas/duplicadas | inerente — pause mídia antes de acionar      |
| Apps sem suporte a scroll-wheel  | nada acontece, atinge timeout                  | depende do app respeitar evento de scroll          |
| Janela menor que viewport real   | overlap maior que esperado                     | algoritmo se adapta, mas frames são pequenos       |

## 7 · Como testar

Em GNOME Shell ativo com Big-Shot instalado:

```sh
# Acionar via keybinding configurado
# (ou via dconf:)
dconf write /org/gnome/shell/extensions/big-shot/scrolling-capture "['<Super><Shift>r']"

# Foque um app rolável, pressione <Super><Shift>R.
# Acompanhe logs:
journalctl --user -f -o cat | grep -i 'big shot'
```

Para iterar no algoritmo de overlap sem rodar a Shell inteira: as funções `findVerticalOverlap` e `stitchFrames` são exportadas de [partscroll.js](../usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/parts/partscroll.js) e funções puras — testáveis em harness GJS standalone.
