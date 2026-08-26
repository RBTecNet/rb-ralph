# Incidente: `happy_mrs_chicken` pausado por parser e estado obsoleto do gerente

- Data da análise: 2026-08-26
- Projeto afetado: `/home/bruno/Documentos/Projetos/testes/happy_mrs_chicken`
- Run: `.rb/runs/happy-mrs-chicken-phases-244ec7359f41`
- Severidade: alta — execução concluída foi convertida em `PAUSED`
- Proprietário principal: time do Ralph
- Participação secundária: resposta do gerente, que em uma chamada omitiu uma linha obrigatória

## Conclusão executiva

A pausa não foi causada pelo código do jogo nem pelos artefatos do Harness. A causa direta foi o Ralph: o parser textual rejeitou uma decisão válida por conter espaços ao fim da linha e, após uma tentativa realmente incompleta, manteve o erro dessa tentativa em memória mesmo quando as respostas seguintes já eram válidas. O circuit breaker usou essa mensagem obsoleta e pausou a execução.

Houve uma falha real do gerente na segunda chamada — ausência da linha `RBT-FINAL` —, mas ela foi corrigida na terceira. O Ralph deveria ter aceitado essa terceira resposta. Portanto, a responsabilidade pelo resultado final incorreto (`PAUSED`) é do Ralph.

## Resultado observado e esperado

Observado:

1. O gerente retornou `COMPLETE`, mas com dois espaços depois do valor.
2. O auditor estruturado considerou a resposta válida.
3. O parser shell considerou a mesma resposta inválida.
4. A segunda chamada omitiu `RBT-FINAL` e foi corretamente rejeitada.
5. A terceira chamada incluiu toda a matriz e foi considerada válida pelo auditor.
6. Mesmo assim, o Ralph repetiu o erro da segunda chamada e terminou em `PAUSED`.

Esperado: depois da terceira chamada válida, o RBF deveria terminar em `COMPLETE`, sem repetir o executor e sem acionar o circuit breaker.

## Evidências

### 1. Divergência entre o parser shell e o auditor estruturado

No log original do gerente, as linhas 75 e 81 terminam com espaços:

```text
.rb/runs/happy-mrs-chicken-phases-244ec7359f41/logs/RBF-attempt-1-manager.log:75
RB_RALPH_AUDIT_STATUS: COMPLETE··

.rb/runs/happy-mrs-chicken-phases-244ec7359f41/logs/RBF-attempt-1-manager.log:81
RB_RALPH_DECISION: COMPLETE··
```

Os símbolos `·` acima representam espaços. A presença deles é verificável sem ambiguidade com:

```sh
sed -n '75,82l' .rb/runs/happy-mrs-chicken-phases-244ec7359f41/logs/RBF-attempt-1-manager.log
```

O auditor estruturado aceitou a resposta:

```text
.rb/runs/happy-mrs-chicken-phases-244ec7359f41/logs/RBF-attempt-1-manager-audit.json:3-5
"valid": true
"auditStatus": "COMPLETE"
"decision": "COMPLETE"
```

Apesar disso, `events.tsv:5` registrou `MANAGER_RETRY` por falta de `RB_RALPH_DECISION` válido.

### 2. O parser exige igualdade exata sem remover espaços finais

Na versão efetivamente executada do Ralph, `bin/rb-ralph:3511-3513` remove o prefixo e `CR`, mas não remove espaços horizontais no fim do valor:

```sh
decision="$(sed -n 's/^RB_RALPH_DECISION:[[:space:]]*//p' "$ACTIVE_MANAGER_LOG" \
  | tr -d '\r' \
  | awk '$0 == "COMPLETE" || $0 == "RETRY" || $0 == "BLOCKED" { value=$0 } END { print value }')"
```

Consequentemente, `COMPLETE  ` não é igual a `COMPLETE`.

### 3. A segunda chamada foi realmente incompleta

O arquivo `RBF-attempt-1-manager-retry-2-audit.json` prova que a segunda resposta tinha quatro das cinco linhas esperadas:

```text
linhas 3 e 56-67:
valid=false
expected=5
reviewed=4
issues=["missing matrix rows: RBT-FINAL"]
```

Essa rejeição foi correta e pertence ao gerente, não ao Harness nem ao executor do jogo.

### 4. A terceira chamada corrigiu a matriz, mas o Ralph não convergiu

O arquivo `RBF-attempt-1-manager-retry-3-audit.json` contém:

```text
linhas 3-5: valid=true, auditStatus=COMPLETE, decision=COMPLETE
linhas 35-37: RBT-FINAL | PASS
linhas 61-71: expected=5, reviewed=5, issues=[]
```

Ainda assim, `events.tsv:7-8` reutiliza exatamente o caminho e a mensagem da segunda chamada e termina em `PAUSED`:

```text
incomplete exhaustive audit: missing matrix rows: RBT-FINAL;
log=.../RBF-attempt-1-manager-retry-2.log
```

### 5. O estado de erro anterior não é limpo

Em `bin/rb-ralph:3516-3521`, uma auditoria inválida preenche `manager_retry_feedback`. Em `bin/rb-ralph:3533-3535`, uma decisão vazia só cria nova mensagem se esse campo já estiver vazio. Não há limpeza do feedback no início da chamada seguinte. Finalmente, `bin/rb-ralph:3558-3560` usa esse valor persistido no circuit breaker.

Isso explica por que a terceira e a quarta chamadas válidas não encerraram o loop e por que o erro final ainda apontava para `manager-retry-2.log`.

### 6. Versão que deve receber a correção

O executável usado foi `/home/bruno/.local/bin/rb-ralph`, resolvido para `/home/bruno/.local/libexec/rb-ralph/bin/rb-ralph`. Seu SHA-256 coincide com `/home/bruno/Documentos/Projetos/IA/rb-harness/rb-ralph/bin/rb-ralph`, versão `0.10.0`.

Ele não coincide com o `bin/rb-ralph` desta árvore `.release-work/rb-ralph`, versão `0.5.1`. O patch e o teste de regressão precisam ser aplicados à linha `0.10.0` e depois propagados para o artefato instalado.

## Causa raiz

O Ralph possui duas interpretações concorrentes do mesmo protocolo:

- o auditor Node normaliza e aceita a resposta;
- o parser shell exige o enum sem espaços finais.

Além disso, `manager_retry_feedback` funciona como estado entre tentativas, mas não é reinicializado por chamada. A combinação transforma um erro transitório já corrigido em falha permanente.

## Correções requeridas — Ralph

1. Centralizar o parsing de `RB_RALPH_DECISION`, `RB_RALPH_REASON` e da matriz em uma única implementação.
2. Remover `CR` e espaços horizontais no início e no fim antes de validar o enum, mantendo validação exata depois da normalização.
3. Em modo `exhaustive`, consumir a decisão do relatório estruturado validado ou garantir que ambos os caminhos usem a mesma função.
4. Reinicializar feedback e resultado transitórios no começo de cada chamada do gerente.
5. Ao receber relatório `valid=true`, decisão válida e razão presente, interromper imediatamente o retry loop.
6. Fazer o evento e o circuit breaker referenciarem somente a chamada atual, nunca um log anterior já superado.

## Ação para o Harness

Nenhuma correção causal foi identificada nos artefatos do Harness neste incidente. Como endurecimento opcional, os prompts podem exigir “sem espaços antes ou depois do valor”, mas isso não substitui um parser robusto no Ralph.

## Testes de regressão obrigatórios

- Uma resposta com `RB_RALPH_DECISION: COMPLETE  ` deve ser aceita.
- Uma resposta com `CRLF` deve ser aceita.
- Valores como `COMPLETE extra` devem continuar rejeitados.
- Sequência: resposta 1 com espaços finais, resposta 2 sem `RBT-FINAL`, resposta 3 completa deve encerrar na terceira chamada.
- O evento final dessa sequência deve ser `COMPLETE` e não pode citar o log da segunda chamada.
- Retries exclusivos do gerente não podem repetir o executor.

## Critério de encerramento

O incidente pode ser encerrado quando a sequência acima passar em teste automatizado na mesma versão que é empacotada/instalada e uma execução de fixture equivalente produzir RBF `COMPLETE` sem feedback obsoleto.
