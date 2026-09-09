# Call Assistant

**Português** · [English](README.md)

Assistente de calls por voz para Dota 2, em Electron, para Windows.

Lê o relógio da partida pela **Game State Integration** oficial da Valve e fala
os timings da sua função — stack, pull, runas, dia/noite, neutros, Tormentor,
cadeia do Roshan — **com a sua própria voz**, gravada por você dentro do app.

Nada sai da máquina: sem conta, sem telemetria, sem rede. Os atalhos só
escutam o teclado, nunca enviam nada para o jogo.

![A tela da partida](docs/live-match.png)

---

## EU SEREI BANIDO???

A resposta honesta primeiro: só a Valve fala pela Valve, e este projeto não vem
com garantia nenhuma. O que dá para fazer é te contar exatamente no que ele
encosta, para você julgar sozinho.

**Ele lê uma coisa só: o JSON que o próprio Dota manda.** A Game State
Integration é um recurso **oficial** da Valve, que vem no jogo, é documentado
por ela e é ligado por uma opção de inicialização que ela mesma fornece —
`-gamestateintegration`. O Dota publica um retrato da *sua* partida num
endereço local algumas vezes por segundo. O app escuta em `127.0.0.1:3000` e lê.
É essa a integração inteira. É o mesmo mecanismo por trás dos overlays de
transmissão que você vê em qualquer campeonato oficial.

**O que ele nunca faz**, e que seria de fato passar do ponto:

- Não lê nem escreve na memória do jogo, e não se acopla, injeta nem engancha
  no processo do Dota.
- Não manda input para o jogo. Os atalhos globais usam o registro de atalho do
  próprio Windows para **escutar**; nada é digitado, clicado ou scriptado
  dentro do Dota.
- Não altera arquivo de jogo. O único arquivo que ele escreve é a config de
  GSI que o recurso da própria Valve lê, na pasta que a Valve criou para isso.
- Não lê chat, não lê os outros jogadores, não enxerga nada sob a névoa — nada
  que você já não veja na sua própria tela.

**Tudo o que ele fala, você poderia falar sozinho** com um cronômetro. O stack
é :53 tendo ou não alguém te lembrando. O app é um timer que fala; ele não te
dá informação que o jogo estava escondendo.

Ele também nunca conversa com a rede: sem conta, sem telemetria, sem ping de
atualização enquanto você joga. O único lugar para onde seus dados vão é o
`%APPDATA%`, na sua máquina.

---

## Baixar (sem terminal)

Se você só quer usar e nunca encostar em código:

1. Vá na página de [**Releases**](../../releases).
2. Baixe o `CallAssistant-<versão>-x64.exe` — o instalador — ou a versão
   portátil, se preferir não instalar nada.
3. Execute. O SmartScreen do Windows vai avisar que o autor é desconhecido,
   porque o build não é assinado (certificado custa dinheiro que este projeto
   não tem). Clique em **Mais informações** → **Executar assim mesmo**, ou
   confira você mesmo: toda release é gerada pelo GitHub Actions a partir do
   código deste repositório, e o log é público.
4. Abra o app, vá em `06 · CONFIGURAR GSI` e siga os três passos de lá.

Daqui para baixo é para quem quer rodar a partir do código.

---

## Requisitos

- Windows 10 ou 11
- [Node.js LTS](https://nodejs.org) (só para rodar/compilar; o instalador final não precisa)
- Dota 2 instalado via Steam

## Rodar

```bash
npm install
npm start
```

## Gerar o instalador

```bash
npm run dist
```

Sai em `release/`: um instalador NSIS e um `.exe` portátil, ambos x64.

Rode **no Windows**. A partir do Linux/WSL o `electron-builder` empacota o app
(`release/win-unpacked/` já fica utilizável), mas falha na etapa final, que
grava ícone e metadados no `.exe` via `rcedit` — isso exige Wine. No Windows
não tem esse passo intermediário.

Outros comandos:

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Roda com o DevTools aberto |
| `npm run watch` | Recompila a cada alteração (rode `npx electron .` em outro terminal) |
| `npm run typecheck` | `tsc --noEmit` no processo principal e no renderer |
| `npm test` | testes do engine de calls (sem build, sem dependência) |
| `npm run pack` | Empacota sem gerar instalador |

---

## Idiomas

Duas configurações separadas, na tela `05 · ÁUDIO`:

- **Voz** — de qual pasta saem os clipes e qual texto é falado (`pt-BR`, `en`)
- **Interface** — o idioma da tela (`pt-BR`, `en`)

São independentes de propósito: dá para ter a interface em inglês com as calls
em português. No primeiro boot o app detecta o idioma do sistema.

### Traduzir para outro idioma

Tudo vive em [`src/shared/i18n.ts`](src/shared/i18n.ts). O objeto `en` é a
fonte da verdade dos tipos: acrescente o novo idioma em `UiLanguage` e em
`MESSAGES`, e o `tsc` aponta uma a uma toda chave que faltar. Nenhuma string
de interface fica espalhada pelo código.

Para uma **voz** nova, o trabalho é em `src/shared/catalog.ts`: cada evento
carrega o próprio `text` com as versões curta e longa por locale.

---

## Ligar no Dota (tela `06 · CONFIGURAR GSI`)

1. **ESCREVER CONFIG** — o app acha a pasta do Dota pelo registro do Steam e
   escreve `gamestate_integration_callassistant.cfg`. Se não achar, use
   **ESCOLHER PASTA** e aponte para `.../steamapps/common/dota 2 beta`.
2. **Adicione `-gamestateintegration`** nas opções de inicialização do Dota 2
   no Steam. O botão **COPIAR** copia pra você — o app não tem como fazer isso
   sozinho, o Steam não expõe isso.
3. **Reinicie o Dota.** Ele só lê os arquivos de GSI ao abrir.

A tela mostra o payload cru chegando, então dá pra ver na hora se funcionou.

![A tela de configuração da GSI](docs/gsi-setup.png)

---

## Gravar as suas calls (tela `05 · ÁUDIO`)

Cada call tem um clipe. Onde não existe gravação, o app usa a voz do Windows
(TTS) como reserva — dá pra usar sem gravar nada.

- **●** ao lado de uma call abre o gravador com a frase na tela.
- **GRAVAR FALTANTES** percorre em fila tudo que ainda não tem clipe.
- No gravador: `espaço` grava e para, `enter` salva, `esc` fecha.

Cada take é cortado no silêncio das pontas e normalizado antes de salvar, então
a call sai no instante em que dispara e todas ficam no mesmo volume.

Os clipes ficam em WAV mono, por locale:

```
%APPDATA%\Call Assistant\recordings\pt-BR\stack.wav
```

O botão **PASTA** abre esse diretório. Dá pra trocar os arquivos na mão, desde
que mantenha o nome (`<id>.wav`).

![A tela de áudio](docs/audio.png)

---

## Overlay, bandeja e início automático

Tudo em `05 · ÁUDIO`, tudo **desligado por padrão**.

O **overlay** é uma faixa de 320×64 no topo da tela com a próxima call e o
tempo. Ele atravessa o clique, não entra no Alt+Tab e não rouba foco — a ideia
é que você esqueça que ele existe. Só aparece com o Dota em janela ou
borderless; em tela cheia exclusiva o Windows não deixa nada por cima.

![A faixa do overlay](docs/overlay.png)

Calls se atropelam — várias caem na mesma janela de poucos segundos — então a
faixa lista as quatro próximas, a mais perto no topo em amarelo e o resto
apagado. O canto onde ela fica se escolhe na mesma tela.

Fechar a janela manda o app para a **bandeja**, de onde dá para silenciar,
ligar o overlay e sair de verdade. **Iniciar com o Windows** sobe o app já
recolhido na bandeja, sem janela na sua cara.

---

## Pacote de voz

`05 · ÁUDIO` → **EXPORTAR** gera um `.zip` com as suas gravações; **IMPORTAR**
lê um. Serve para levar a sua voz para outra máquina — ou para alguém baixar a
sua e usar no lugar da voz do Windows.

O leitor trata o arquivo como hostil: valida CRC e tamanho de cada entrada,
recusa nome com caminho (`../`, `/`, subpasta), ignora clipe desconhecido e
corta entrada acima de 8 MB. Um `.zip` da internet não é confiável.

---

## Atalhos globais

Funcionam com o Dota em foco. Remapeáveis em `05 · ÁUDIO`.

| Padrão | Ação |
| --- | --- |
| `F9` | Muta / desmuta tudo |
| `num1` | Marca o Roshan (dispara aegis → possível → garantido) |
| `num0` | Paleta rápida: duas letras e some sozinha |

Paleta: `AE` aegis inimigo · `GL` glyph inimigo · `BB` buyback inimigo ·
`SM` smoke avistado.

---

## Como o app decide o que falar

Uma call por segundo, no máximo. Quando duas caem juntas, a de maior
prioridade fala e a outra vira `DROPPED` no log — o log mostra tudo que foi
considerado, falado ou não, então dá pra entender o silêncio.

O que cala a call, em ordem:

| Estado | Efeito |
| --- | --- |
| Mute global (`F9`) | cala tudo |
| Jogo pausado | cala tudo |
| Você morto | cala tudo, menos a cadeia do Roshan |
| **FIGHT** ligado | só prioridade 5 |
| Orçamento por minuto estourado | só prioridade 4+ |

O orçamento (2 a 8 calls por minuto) é o que evita virar rádio. Padrão: 4.

A tela `04 · CONJUNTO DE CALLS` mostra o conjunto da sua função e deixa silenciar
eventos individuais.

### Timings (patch 7.41e)

| Call | Quando | Aviso |
| --- | --- | --- |
| Stack | :53 de cada minuto, 1:53–30:00 | 10s |
| Pull | :15 de cada minuto, 1:00–15:00 | 6s |
| Bounty | a cada 3:00 | 10s |
| Runa de poder | a cada 2:00, a partir de 6:00 | 15s |
| Wisdom | a cada 7:00 | 20s |
| Noite / Dia | 5:00 e 10:00, alternando | 10s |
| Neutros tier 2 / tier 3 | 17:30 / 27:30 | 10s |
| Tormentor | 20:00 | 30s |
| Aegis expira / Rosh possível / garantido | +5:00 / +8:00 / +11:00 da marcação | 10s |

Além dessas, quatro calls saem do **estado**, não do relógio: **sem buyback**
(depois dos 20:00, vivo, ouro abaixo do custo), **sem TP** (depois dos 2:00),
**ultimate pronta** e **item pronto**. As duas últimas falam só na transição
de cooldown para pronto, e só se a espera valeu a pena — 30s para a ultimate,
12s para os itens, senão blink e force staff nunca abririam a boca.

---

## Sem o Dota aberto

O painel **SIMULAÇÃO** na lateral roda um relógio falso: `RODAR` corre em tempo
real, `+30s` pula. Serve para conferir as calls e testar as gravações sem
entrar em partida.

---

## Estrutura

```
src/
  shared/      catálogo de eventos e clipes, textos da interface, tipos do IPC
  main/        processo principal: servidor GSI, atalhos, config do Dota, arquivos
  preload/     ponte de IPC (contextIsolation ligado)
  renderer/    engine de calls, áudio, gravador, overlay e as 7 telas
tests/         testes do engine, em node:test puro
build.mjs      esbuild: bundles + estáticos
```

O renderer não usa framework: DOM direto, reconstruído a cada tick.

---

## Limitações conhecidas

- A GSI não informa estoque de wards na loja nem posição dos inimigos. O painel
  de disciplina só enxerga o que está no seu inventário.
- Roshan e os timers da paleta são manuais hoje. A GSI tem um fluxo `events`
  de mensagens de chat, então parte disso pode ser detectável — até agora só
  observei compra de item, e num demo de herói. O `tools/gsi-probe.mjs` existe
  para resolver isso contra uma partida de verdade.
- O overlay não aparece com o Dota em tela cheia exclusiva. Use janela ou
  borderless, ou simplesmente deixe desligado: o app foi feito para ser
  ouvido, não olhado, durante a partida.
- Cooldown de ultimate e item exige `abilities` na config da GSI. Config
  escrita por versão antiga não tem isso, e a tela de GSI agora avisa — clique
  em **REESCREVER** por lá e reinicie o Dota.
