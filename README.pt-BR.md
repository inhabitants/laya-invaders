# laya-invaders

[English](README.md) · **Português**

Space Invaders ao contrário, como teste pra um modelo de decisão. Você (ou um bot) solta os invasores. O [Laya](https://github.com/NandhaKishorM/laya), um modelo de decisão de 322M da Convai Innovations, só escolhe qual o canhão persegue. Do lado, o mesmo ataque enfrenta uma regra de uma linha: atira no invasor que pousa primeiro.

![Lado a lado no mesmo ataque: o Laya deixa invasor passar enquanto a regra de uma linha segura quase todos](docs/invaders.gif)

*Uma partida real numa RTX 3070, reproduzida em 1×. Mesmo ataque com semente dos dois lados.*

## Por que este teste

O Laya responde perguntas tipadas com probabilidades numa passada só, com zero token de saída. No demo da cobrinha ([laya-snake-cuda](https://github.com/inhabitants/laya-snake-cuda)) um planejador escreve "Best" do lado de uma das opções, então aquele demo mostra velocidade e formato, não julgamento. Aqui o Laya recebe uma decisão de verdade: qual ameaça primeiro.

## O que deixa o teste justo

- **Fato, não conselho.** Cada invasor chega como fato: o tipo, a distância do canhão, quantas rodadas faltam pra pousar e quantos tiros aguenta. Por exemplo: `tank, 3 columns to the left, lands in 42 ticks, needs 3 hits`. Nenhuma opção vem marcada como a melhor.
- **A ordem não diz nada.** Quando tem mais de 5 invasores na tela, entram os 5 mais perto de pousar, listados da esquerda pra direita.
- **As mesmas mãos.** Mirar e atirar é código comum, igual pros dois lados. A única coisa que muda é quem escolhe o alvo.
- **O mesmo ataque.** O atacante é um bot com semente que nunca olha a defesa, então a mesma semente solta os mesmos invasores nas mesmas rodadas, seja quem for defendendo.

O Laya também responde uma segunda pergunta na mesma passada (pressão: tranquila, apertada ou sufocada). O painel mostra; o canhão não usa.

## Resultado

Mesma semente pros dois, 600 rodadas (60 segundos de jogo):

| Ataque | Regra (pousa primeiro) | Laya | Escolhas em comum |
|---|---|---|---|
| Normal | 52 de 52 | 50 de 52 | 86% |
| Energia dobrada pro atacante | 87 de 89 | 71 de 87 | 35% |

Uns 50 ms por decisão do Laya na RTX 3070. A regra ganha, e a diferença cresce com a pressão. As partidas são determinísticas: a mesma semente deu os mesmos números duas vezes.

Rápido e bem formatado não é o mesmo que saber pesar. Deixa uma régua burra do lado de qualquer modelo de decisão.

## Rodar

Python 3.10 ou mais novo.

```bash
git clone https://github.com/inhabitants/laya-invaders
cd laya-invaders
python -m venv .venv
```

Ative (`.venv\Scripts\activate` no Windows, `source .venv/bin/activate` no Linux) e depois:

```bash
# Placa NVIDIA: instale antes um PyTorch com CUDA (RTX série 50 pede cu128 ou mais novo)
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install -r requirements.txt
python server.py --download
python server.py
```

O `--download` baixa o checkpoint multilíngue (~0,65 GB) em `./models/laya`, travado na revisão de onde saíram estes números. Depois abre http://127.0.0.1:8765. O servidor só escuta na sua máquina. Sem placa: pule a linha do torch e acrescente `--device cpu` (uns 300 ms por decisão; aperte `-` pra deixar o jogo mais lento).

| Tecla | |
|---|---|
| **Clique** numa coluna | Solta um invasor ali |
| **1 2 3** | Escolhe o tipo: corredor, zigue-zague, tanque |
| **M** | Troca o cérebro entre o Laya e a regra |
| **T** | Liga ou desliga o bot atacante |
| **Espaço** / **R** / **+ -** | Pausa / reinicia / velocidade |

Tela em português: http://127.0.0.1:8765/?lang=pt

## Repetir o teste

No console do navegador:

```js
layaInvaders.run({ ticks: 600, seed: 1, energyEvery: 3 })  // uns 2 minutos
layaInvaders.summary()
```

`energyEvery: 6` é o ataque normal, `3` o dobrado. Pra exportar a reprodução lado a lado, suba o servidor com `--frames-dir frames`, rode o teste, depois `layaInvaders.exportRun({ from: 0, to: 600 })` e transforme os quadros em vídeo:

```bash
ffmpeg -framerate 10 -i frames/f%05d.png -r 30 -c:v libx264 -crf 20 -pix_fmt yuv420p replay.mp4
```

## Estado

Publicado como está, sem manutenção. Testado no Windows 11, Python 3.11, PyTorch 2.11 (CUDA 13), `laya` 0.3.5, RTX 3070. A página carrega a fonte League Spartan do Google Fonts.

## Licença

MIT pra este código, veja [LICENSE](LICENSE). O Laya e os pesos dele são Apache-2.0, da Convai Innovations; os pesos são baixados à parte e não estão incluídos aqui.

---

Feito no [Sapiens Sintéticos](https://www.sapiensinteticos.com).
