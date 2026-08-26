# Incidente: `Atravessar_a_rua` concluído com interface visual quebrada

- Data da análise: 2026-08-26
- Projeto afetado: `/home/bruno/Documentos/Projetos/testes/Atravessar_a_rua`
- Run: `.rb/runs/phases-init-6c21416c140b`
- Severidade: crítica — produto foi marcado como concluído apesar de estar visualmente inutilizável
- Causa direta do defeito: implementação de T014
- Proprietário do falso positivo final: time do Ralph
- Lacuna contribuinte: time do Harness, por gerar validação visual apenas manual e sem prova obrigatória

## Conclusão executiva

O defeito concreto está em `src/ui/board-renderer/index.js`: o renderer insere um elemento `<style class="board-style">` dentro do tabuleiro e aplica `display: contents` a esse mesmo elemento. Isso sobrescreve o comportamento oculto nativo de `<style>` e faz o texto CSS aparecer como conteúdo/grid item do tabuleiro. O texto ocupa grande parte do layout e desloca galinha e veículos para fora da área útil.

Quem escreveu T014 causou o bug. Entretanto, a afirmação final de que o projeto estava concluído é responsabilidade do fluxo de encerramento do Ralph: executor RBF e gerente abriram Chrome e testaram presença de elementos e mudança de estado, mas não verificaram o que o usuário realmente via. Não houve screenshot persistida, asserção de geometria/visibilidade nem inspeção do CSS computado.

O Harness contribuiu ao transformar requisitos explicitamente visuais em uma instrução `manual:` sem protocolo de evidência. O Ralph tratou essa instrução não executada como suficiente para `PASS`.

## Resultado observado e esperado

Observado em Chrome real durante a análise:

- texto-fonte CSS visível dentro do tabuleiro;
- tabuleiro com geometria distorcida;
- galinha e veículos fora ou abaixo da região inicialmente visível;
- DOM, teclado e transições de estado ainda presentes, o que enganou os testes estruturais.

Esperado:

- nenhum texto de stylesheet visível;
- tabuleiro, galinha, pistas e veículos simultaneamente visíveis dentro da área útil;
- a conclusão final condicionada a evidência visual/geométrica durável.

## Evidências

### 1. Regra CSS que torna o `<style>` renderizável

Em `src/ui/board-renderer/index.js:25-27`:

```css
[data-crossing-board] .board-style {
  display: contents;
}
```

Em `src/ui/board-renderer/index.js:356-358`:

```js
const stylesheet = createElement(documentRef, 'style', 'board-style');
stylesheet.textContent = BOARD_RENDERER_CSS;
board.appendChild(stylesheet);
```

A folha contém todo o CSS a partir da linha 5. Ao tornar o elemento `style` equivalente a `display: contents`, seu nó de texto participa do layout do grid. Essa é a causa direta e suficiente do sintoma visual reproduzido.

### 2. T014 exigia visibilidade, mas não tinha validação executável

Em `.rb/runs/phases-init-6c21416c140b/phases/P05-T014.txt:18-30`:

```text
AC-T014-01: tabuleiro exibe simultaneamente galinha, rua, pistas e chegada
AC-T014-02: pistas e espaços são diferenciados visualmente
AC-T014-03: quatro tipos de veículo são visíveis
Validation: manual: inspect the board renderer...
```

O requisito era visual; a validação gerada não produzia resultado verificável automaticamente.

### 3. O executor de T014 declarou `COMPLETE` sabendo que não inspecionou no navegador

Em `logs/P05-T014-attempt-1-agent.log:70-72` foram executados apenas `node --check` e um DOM falso que verifica estrutura, atributos e URIs. Nas linhas 72/86-88, o executor afirma:

```text
Risco restante: não há entrypoint de navegador configurado para inspeção visual manual.
RB_RALPH_EXECUTOR_STATUS: COMPLETE
```

Uma prova estrutural não demonstra “visível”. O DOM falso não implementa layout ou CSS e, portanto, não poderia detectar `display: contents` no elemento `<style>`.

### 4. O índice de evidência registra instruções manuais, não sua execução

Em `.rb/runs/phases-init-6c21416c140b/evidence/P05-attempt-1-index.json:39-52`:

```text
commands: []
manual: [instruções para inspecionar T014, T015 e T016]
```

Não há resultado, responsável, timestamp, screenshot ou aprovação humana associado a essas instruções. Mesmo assim, a fase foi fechada.

### 5. O teste operacional não abre navegador

Em `tests/integration/operational/consumer.test.js:40-58`, o teste:

- gera `dist/game.js`;
- inicia servidor HTTP;
- confirma status 200;
- procura referências textuais a `dist/game.js` e `startBrowserGame`.

Ele não renderiza a página e não mede visibilidade, geometria ou conteúdo visual.

### 6. O RBF usou Chrome real, mas validou apenas estado lógico

Em `logs/RBF-RBT-FINAL-attempt-1-agent.log:116-126`, Chrome headless é controlado por CDP. As expressões consultam:

- existência de shell/tabuleiro;
- `style.top` da galinha antes e depois de `ArrowUp`;
- texto de status;
- quantidade de veículos;
- layout e multiplicador.

Não aparecem chamadas a `Page.captureScreenshot`, `getBoundingClientRect` ou `getComputedStyle`. Um elemento pode existir, responder ao teclado e ainda estar fora da viewport ou encoberto. Foi exatamente o que ocorreu.

### 7. O gerente repetiu o mesmo tipo de prova insuficiente

O gerente também iniciou Chrome por `--remote-debugging-port` e marcou todos os critérios como `PASS`. Em `logs/RBF-attempt-1-manager-retry-2-audit.json:3-5,33-71`:

```text
valid=true
auditStatus=COMPLETE
decision=COMPLETE
pass=5
issues=[]
```

A evidência de AC-RBF-02 diz que Chrome completou a travessia via teclado, mas não prova que a travessia era visível.

### 8. Não existe artefato visual durável no pacote de evidência

O diretório `.rb/runs/phases-init-6c21416c140b/evidence` contém índices, snapshots de mudança e seleção de validações. Não contém PNG/JPEG/WebP nem outro arquivo de captura visual. Assim, o gerente e uma revisão posterior não tinham imagem canônica para auditar.

## Causa raiz e falhas de contenção

### Causa direta

T014 criou uma regra incompatível com o tipo especial do elemento `<style>`. O defeito pertence à implementação.

### Por que P05 não conteve

- O Harness gerou apenas uma instrução manual para critérios visuais.
- O executor substituiu inspeção visual por DOM falso e declarou `COMPLETE` apesar do risco explícito.
- O gerente aceitou presença de seletores como evidência de visibilidade.

### Por que RBF não conteve

- O Ralph não exige evidência visual para produto browser.
- Executor e gerente verificaram comportamento lógico, não apresentação renderizada.
- O protocolo permite `PASS` sem screenshot ou métricas de layout.
- O índice de evidência não distingue “instrução manual cadastrada” de “verificação manual executada e aprovada”.

## Correções requeridas — Harness

1. Para critérios com termos como “visível”, “layout”, “exibe”, “alinhado” ou “responsivo”, gerar validação de navegador executável ou marcar `HUMAN_PENDING`.
2. Nunca considerar uma linha `manual:` como resultado; exigir registro separado de execução, responsável e artefato.
3. Incluir critérios negativos para UI, como ausência de texto CSS/JS exposto e ausência de elementos essenciais fora da viewport.
4. Gerar contrato de evidência visual: viewport definida, screenshot antes/depois de interação e medidas mínimas de geometria.
5. Fazer a fase permanecer aberta quando o próprio executor declara que a inspeção visual necessária não pôde ser realizada.

## Correções requeridas — Ralph

1. No RBF de aplicações browser, exigir screenshots persistidas no diretório de evidência.
2. Exigir console errors, `getComputedStyle` e `getBoundingClientRect` para elementos visuais essenciais.
3. Confirmar que tabuleiro, galinha e pelo menos os veículos esperados intersectam tabuleiro e viewport e têm dimensões positivas.
4. Fazer o gerente inspecionar independentemente a screenshot, não apenas reutilizar estados DOM produzidos pelo executor.
5. Tratar evidência visual ausente como `UNPROVEN` ou `HUMAN_PENDING`, nunca como `PASS`.
6. Validar o índice: um critério visual em `PASS` sem artefato/medida correspondente deve invalidar a auditoria exaustiva.

## Testes de regressão obrigatórios

- Fixture que injeta `<style class="board-style">` com `display: contents` deve falhar no gate visual.
- Asserção: `getComputedStyle(document.querySelector('style.board-style')).display === 'none'` ou stylesheet instalado fora da árvore visual.
- Asserção: `document.body.innerText` não contém trechos exclusivos de CSS do renderer.
- Asserções de bounding box: tabuleiro com dimensões razoáveis; galinha e veículos com área positiva e interseção com o tabuleiro/viewport.
- Screenshot obrigatória antes e depois de uma tecla, registrada no índice de evidência.
- Teste negativo: presença de seletores e mudança de `style.top` sem visibilidade real não pode encerrar RBF.

## Critério de encerramento

O incidente pode ser encerrado quando a fixture defeituosa for rejeitada, uma UI válida produzir prova visual durável e o protocolo impedir `COMPLETE` sempre que um critério visual estiver apenas instruído, mas não comprovado.
