# RB Ralph

[English](README.md) · [Português do Brasil](README.pt-BR.md)

O RB Ralph é o consumidor opcional dos artefatos gerados pelo RB Harness. Ele é
um gerenciador de execução neutro de provider: um agente implementa, uma LLM
gerente revisa evidências e gates determinísticos mantêm a autoridade final
sobre testes e validações executáveis.

O Ralph consome `rb-manifest/v1` e planos `rb-execution/v1`. Também entende o
contrato opcional `rb-operational/v1` para aceitação operacional em ambiente
limpo. A documentação do Harness não depende do Ralph e pode ser entregue a
outro executor compatível.

`RB-RALPH-CONTRACT-IDENTITY.json` acompanha o pacote e vincula a versão do
runtime ao status do contrato consolidado. O snapshot consolidado `0.8.11` é
histórico; `rb-manifest/v1`, `rb-execution/v1` e `rb-operational/v1` continuam
contratos de dados independentes e autoritativos.

> **Padrão de segurança:** sem uma flag explícita, os providers rodam em modo
> YOLO com as permissões do usuário atual do sistema operacional. Use
> `--protected` ou execute projetos não confiáveis em VM, container ou conta
> descartável.

## Requisitos e instalação

O runtime funciona com Bash 3.2 ou superior, inclusive o Bash distribuído pelo
macOS. Também são necessários Node.js, Git e as CLIs escolhidas para executor e
gerente.

No clone do `rb-ralph`:

```bash
./rb-ralph.sh --install
```

O prefixo padrão é `~/.local`. Se necessário:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Para outro prefixo do usuário:

```bash
./rb-ralph.sh --install --prefix "$HOME/tools"
```

Instalação global:

```bash
sudo ./rb-ralph.sh --install --prefix /usr/local
```

O instalador copia o runtime completo: launcher, adapters, dashboard, supervisor
de processos, evidências, controle de locks, perfis e o core determinístico do
RB Harness. Execute novamente o mesmo comando para atualizar.

Confira a versão:

```bash
rb-ralph --ver
rb-ralph --version
# RB Ralph 0.10.1
```

Para remover apenas os recursos identificados como pertencentes ao Ralph:

```bash
./rb-ralph.sh --uninstall
./rb-ralph.sh --uninstall --prefix "$HOME/tools"
```

## Primeiros comandos

Listar planos prontos sem chamar provider:

```bash
rb-ralph --project /caminho/do/projeto --list
```

Validar o plano e o agendamento sem criar um run:

```bash
rb-ralph --project /caminho/do/projeto \
  --plan <artifact-id> \
  --dry-run
```

Executar:

```bash
cd /caminho/do/projeto

rb-ralph --project . \
  --plan <artifact-id> \
  --provider codex
```

Use `rb-ralph --help` para a lista completa de opções.

## Assistente interativo e perfis

Executar apenas `rb-ralph` abre o wizard. `rb-ralph --wizard` é o equivalente
explícito. O assistente:

1. escolhe projeto e diretório de artefatos;
2. descobre apenas planos `rb-execution/v1` válidos e prontos;
3. seleciona um perfil embutido ou salvo;
4. pergunta provider, modelo e effort do executor e gerente;
5. configura auditoria, paralelismo, permissões, isolamento e timeouts;
6. mostra o comando exato antes de executar.

Perfis embutidos:

| Perfil | Política |
| --- | --- |
| `balanced` | contexto novo por task, gerente exaustivo, auditoria final, dashboard e YOLO |
| `fast` | contexto novo por fase, gerente exaustivo, auditoria final, dashboard e YOLO |
| `strict` | contexto novo por task, gerente exaustivo, auditoria final, dashboard e modo protegido |

Gerencie perfis personalizados:

```bash
rb-ralph profile list
rb-ralph profile show meu-time
rb-ralph profile path
rb-ralph profile delete meu-time
```

Utilize um perfil:

```bash
rb-ralph --profile meu-time \
  --project . \
  --plan <artifact-id>
```

Flags explícitas ganham dos valores do perfil. Perfis nunca armazenam API keys,
tokens, paths de projeto, IDs de plano ou outros segredos.

## Diretórios de artefatos alternativos

O Ralph procura `.rb` por padrão. Para artefatos gerados por outro harness:

```bash
rb-ralph --project . --artifacts-dir .spec --list
rb-ralph --project . --fragments-dir .spec --plan <artifact-id>
```

`--fragments-dir` é alias exato de `--artifacts-dir`. Os paths internos do
manifesto continuam lógicos como `.rb/...`; não é necessário renomear a pasta.

## Providers e modelos

Providers embutidos:

- Codex;
- Claude Code;
- OpenCode;
- providers de API direta suportados pelo cofre compartilhado;
- adapters personalizados com `--agent-cmd` e `--manager-cmd`.

Mesmo provider nos dois papéis:

```bash
rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --model gpt-5.6-sol \
  --effort high
```

Modelos diferentes:

```bash
rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --agent-model gpt-5.4-mini \
  --manager-model gpt-5.6-sol
```

Providers diferentes:

```bash
rb-ralph --project . --plan <artifact-id> \
  --agent-provider opencode \
  --agent-model opencode/mimo-v2.5-free \
  --manager-provider codex \
  --manager-model gpt-5.6-sol
```

Effort independente:

```bash
rb-ralph --project . --plan <artifact-id> \
  --agent-provider codex --agent-model gpt-5.4-mini --agent-effort high \
  --manager-provider codex --manager-model gpt-5.6-sol --manager-effort xhigh
```

O Ralph não inventa uma enum universal de effort. Ele encaminha o token ao
provider: Codex recebe `model_reasoning_effort`, Claude recebe `--effort` e
OpenCode recebe `--variant`. Se o modelo não aceitar o valor, a chamada falha
visivelmente.

Configure e teste credenciais de API direta:

```bash
rb-ralph --login
rb-ralph provider list
rb-ralph provider test
```

## Política de permissão

YOLO é o padrão do executor. O gerente G3 sempre recebe autoridade protegida e
somente de leitura:

```bash
rb-ralph --project . --plan <artifact-id> --provider codex
rb-ralph --project . --plan <artifact-id> --provider codex --yolo
```

Modo protegido:

```bash
rb-ralph --project . --plan <artifact-id> --provider codex --protected
```

Em modo protegido, o executor Codex recebe workspace-write; o gerente continua
em read-only. Claude usa `acceptEdits` no executor e `plan` no gerente. OpenCode
usa permissões de negação no gerente. Overrides que dariam escrita ao gerente
falham explicitamente. Um adapter personalizado que não consiga respeitar
`protected` deve falhar; o Ralph também sela o estado completo do produto antes
e depois de G3 e rejeita qualquer mutação.

## Unidade de execução e contexto novo

Cada chamada de provider é efêmera e sem sessão persistente. O padrão é:

```bash
--execution-unit task
```

Cada task pendente recebe contexto novo, seu próprio escopo, critérios e
evidências necessárias. `--execution-unit phase` existe para compatibilidade,
mas acumula mais contexto e dá uma unidade maior ao executor.

Continuidade vem dos artefatos e evidências versionadas:

- retries recebem achados abertos e referências aos logs anteriores;
- o gerente recebe o plano validado e um índice limitado de evidências;
- fases aceitas são retomadas apenas quando o hash do plano é igual;
- nenhuma compactação de chat é tratada como fonte de verdade.

## Executor, gerente e gates

Para cada unidade, o Ralph:

1. chama um executor novo;
2. coleta paths alterados e evidências;
3. executa validações determinísticas aplicáveis;
4. chama o gerente técnico em contexto independente;
5. aceita, solicita retry ou pausa conforme contratos e evidências.

Um exit code diferente de zero, integração de patch com falha ou teste
determinístico vermelho sempre vence uma resposta otimista do gerente. O
gerente revisa e decide; ele não implementa a correção.

`--manager-audit exhaustive` exige que o gerente devolva o lote atual completo
de achados, agrupado por causa raiz. Isso evita corrigir uma falha por retry e
descobrir outra que já existia na mesma entrega.

No retry seguinte, `FAIL` e `UNPROVEN` estruturados selecionam somente a menor
closure de tasks determinada pelas linhas validadas da matriz. Campos livres do
finding, como `boundary` e `expected`, são diagnósticos e não adicionam tasks ou
paths à autoridade de retry. Achados sem mapeamento determinístico usam fallback
conservador registrado, sem adivinhar uma task.

## Validação incremental

No primeiro attempt da fase, o Ralph estabelece a baseline completa dos
comandos únicos declarados em `PHASES.md`. Depois de um retry:

- identifica paths realmente alterados;
- cruza esses paths com os `Scope` das tasks;
- invalida tasks afetadas e dependentes;
- reutiliza resultados verdes de comandos não afetados;
- executa tudo novamente se o escopo for ambíguo ou incompleto.

Isso evita executar centenas de testes quando uma alteração comprovadamente
afeta apenas uma fatia pequena, mas mantém fallback conservador quando a
documentação não permite provar isolamento.

Na unidade padrão `task`, a mesma sintaxe de `Scope` também é a fronteira
mecânica de escrita. O Ralph compara o estado completo por task, dá precedência
à proteção dos artefatos de autoridade e interrompe antes de G2/G3 se houver um
path fora do escopo autorizado.

Configure timeout dos comandos:

```bash
rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --validation-timeout 600
```

`--validation-mode manager` desliga a autoridade de comandos do Ralph e deve
ser usado apenas quando um ambiente controlado externo possui toda a validação.

## Paralelismo seguro

Tasks podem executar em paralelo quando todas são `Parallel safe: true`, não
dependem entre si e seus escopos não colidem:

```bash
rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --parallel 4
```

Cada agente trabalha em worktree Git destacada criada do mesmo snapshot
imutável. O Ralph verifica os patches e só então os combina na árvore
principal. Dois patches que tocam o mesmo path ou entram em conflito são
rejeitados sem sobrescrever silenciosamente o trabalho de um agente.

Fases continuam sequenciais. O paralelismo ocorre apenas entre tasks
independentes da fase atual.

## Escopo de revisão do gerente

`--manager-review` escolhe com que profundidade o gerente técnico julga uma fase.

| Modo | Pergunta que ele responde |
| --- | --- |
| `delivery` (padrão) | O executor entregou o que este fragmento pedia? |
| `code` | Isso, mais: o código alterado está correto? |

Em `delivery`, um critério cujo resultado observável está evidenciado pelo código
atual, pelas linhas de validação ou pelo índice de evidências é `PASS`. O gerente
não retém a aceitação por estilo, nomenclatura, estrutura, profundidade de teste
ou qualquer preocupação que o fragmento não pediu, e não abre findings para
defeitos fora dos critérios declarados. `FAIL` e `UNPROVEN` pertencem a um
critério que o executor não entregou ou não evidenciou — não a um trabalho
entregue de um jeito diferente do que o revisor faria.

Em `code`, o gerente julga a entrega primeiro e depois audita o código alterado:
lógica incorreta em uma fronteira modificada, caminho de erro ausente, classe de
entrada não tratada, invariante quebrada ou regressão em comportamento que a fase
deveria preservar. Um critério tecnicamente satisfeito por código defeituoso não
é `PASS`.

```bash
# o padrão: aceita a fase assim que o fragmento foi entregue
bin/rb-ralph --project . --plan feature-example-execution --provider codex

# optar pela revisão mais rigorosa
bin/rb-ralph --project . --plan feature-example-execution --provider codex \
  --manager-review code
```

`RB_RALPH_MANAGER_REVIEW` define o mesmo valor, e um perfil pode declarar
`execution.managerReview`. O perfil embutido `strict` usa `code`; `balanced` e
`fast` usam `delivery`.

**O escopo estreita apenas o julgamento.** Ele nunca aprova por cima de um gate
determinístico: saída não zero do executor, comando de validação reprovado ou
finding reaberto sobre evidência inalterada continuam convertendo `COMPLETE` em
`RETRY` — e essa conversão é feita pelo orquestrador em código, não pelo gerente
em um prompt. A fase final de aceitação operacional (`RBF`) também revisa sempre
com profundidade total: ela existe para exercitar a fronteira real do consumidor,
que é outra pergunta.

## Contexto de repositório pré-carregado

Cada task roda em um processo novo, sem sessão, então o agente redescobre o
repositório do zero. Medido em uma execução real: o prompt entregue pelo RB
Ralph tinha 3,7 KB, e o agente gastava de 445k a 1520k tokens de entrada por
task, com 82% dos seus comandos de shell sendo redescoberta — listar arquivos,
buscar módulos e reler o próprio plano que o prompt já continha em extrato. O
gerente fazia o mesmo, gastando 194k tokens de entrada relendo uma árvore que o
RB Ralph já havia diferenciado.

O RB Ralph já sabe tudo isso. A task declara seu `Scope`, a fase declara seu
`Context`, e o snapshot de evidências cataloga a árvore e o que as tasks
anteriores mudaram. Esse estado passa a ser entregue ao executor e ao gerente em
vez de caçado:

- o conteúdo atual dos arquivos que a task declara em `Scope`, ou um aviso
  nomeando os caminhos de escopo que ainda não existem;
- as seções estruturadas exatas nomeadas por `Covers`, selecionadas por ID antes
  dos prefixos não relacionados dos documentos;
- um mapa limitado do `Scope`, arquivos existentes e nomes públicos das
  dependências declaradas;
- paths alterados anteriormente somente quando intersectam essas fronteiras;
- um catálogo reduzido do produto, sem `.rb`, `.rb-harness`, `.git`,
  dependências, caches, builds, binários, logs ou snapshots de execução;
- os prefixos restantes dos documentos de `Context`, somente por último;
- para o gerente, o conteúdo atual dos caminhos alterados, código primeiro,
  sem lockfiles.

Isso não é autoridade nova. É o estado atual do repositório, que a ordem de
autoridade do executor já classifica em segundo lugar, entregue em vez de
procurado. Cada seção respeita um orçamento de bytes declarado e toda omissão é
declarada, então uma seção truncada nunca se lê como completa.

```bash
--no-agent-context           # desliga; vem ligado por padrão
--agent-context-bytes <n>    # orçamento da seção do executor (padrão 49152)
```

`RB_RALPH_AGENT_CONTEXT=0`, `RB_RALPH_AGENT_CONTEXT_BYTES` e
`RB_RALPH_MANAGER_CONTEXT_BYTES` definem os mesmos valores pelo ambiente.

## Foco do painel

A tabela de tasks acompanha a unidade em execução. Quando ela não cabe no
terminal, a janela se centra na task que está rodando, mantém o cabeçalho da
fase à vista — para que uma task visível sempre diga a que fase pertence — e
informa o que ficou escondido de cada lado (`↑ 14 acima · ↓ 10 abaixo`) em vez
de encerrar a lista em silêncio.

Isso falhava de um jeito fácil de confundir com travamento: a âncora procurava o
ID da fase corrente no texto **já renderizado**, mas toda linha começa com uma
borda colorida, então a busca nunca casava e a janela se fixava no topo da
tabela. Uma fase longa exibia apenas suas tasks concluídas enquanto a que
realmente executava ficava abaixo do corte. As linhas passam a ser marcadas na
construção, então o foco não depende mais de interpretar texto feito para tela.

## Atividade das chamadas

Totais de token escondem o formato de uma chamada. Uma task observada reportou
1,52M tokens de entrada contra vizinhas em ~500k, e só o log bruto mostrou o
porquê: 34 comandos de shell em vez de ~20. Cada chamada de provider passa a
registrar suas contagens de comandos, edições e mensagens no diretório
`activity/` da execução, para distinguir uma task grande de um agente preso em
redescoberta. Esses contadores também aparecem ao vivo. Limites suaves apenas
avisam; limites duros explícitos pausam de forma recuperável, preservam mudanças
e evidências e nunca produzem `COMPLETE` artificial:

```bash
RB_RALPH_CONTEXT_SOFT_COMMAND_LIMIT=40
RB_RALPH_CONTEXT_SOFT_OUTPUT_BYTES=1048576
RB_RALPH_CONTEXT_HARD_COMMAND_LIMIT=0   # desabilitado por padrão
RB_RALPH_CONTEXT_HARD_OUTPUT_BYTES=0    # desabilitado por padrão
```

Um stream de provider que o leitor não reconhece é reportado como `unmeasured`,
nunca como zero.

## Dashboard

```bash
rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --dashboard
```

`--tui` é alias. Para um snapshot não interativo:

```bash
rb-ralph-watch --project . --plan <artifact-id> --once
```

O painel mostra fase/task, attempt, gate, provider/model, tempo, bytes do prompt
inicial, entrada cumulativa do provider, cache como parcela dessa entrada,
entrada não cacheada derivada, saída, compactação, maiores chamadas por tokens,
comandos e bytes de log, custo, waits e circuit breaker. Entrada cumulativa
nunca é rotulada como tamanho de uma janela simultânea. Telemetria não substitui
os gates de conclusão.

## Tokens e custos

Adapters embutidos normalizam uso reportado pelo provider. Um arquivo de preços
opcional permite estimativas quando custo real não é fornecido:

O contrato `rb-ralph-usage/v1` mantém sua semântica. O artefato adicional
`rb-ralph-context-efficiency/v1`, em `context-efficiency/<execution-id>/`, reúne
prompt, entrada cumulativa, cache, entrada não cacheada, saída, comandos,
edições, mensagens, bytes do log e sinal nativo de compactação. No Codex, cache
é subconjunto da entrada e não é somado novamente ao total.

```bash
cp pricing.example.json pricing.json

rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --pricing-file pricing.json
```

Estimativas são lineares por classe de token e não incluem impostos, câmbio,
tiers de contexto, assinatura ou taxas especiais. Custo reportado pelo provider
tem preferência. Adapters personalizados podem permanecer explicitamente não
medidos.

## Timeouts, retries e circuit breaker

Defaults principais:

- `--max-attempts 3`: janela consecutiva sem progresso;
- `--max-strategy-resets 1`: uma troca explícita de estratégia;
- `--max-total-attempts 12`: teto absoluto de chamadas do executor por fase;
- `--manager-retries 3`: retries exclusivos do gerente sobre a mesma evidência;
- `--agent-timeout 3600`: tempo total do executor;
- `--agent-idle-timeout 300`: executor sem atividade observável;
- `--agent-first-output-timeout 300`: tempo até o primeiro byte;
- `--manager-timeout 900`: tempo total do gerente;
- `--manager-idle-timeout 180`: gerente sem atividade;
- `--manager-first-output-timeout 180`: tempo até o primeiro byte do gerente.

Exemplo para execução longa, mas limitada:

```bash
rb-ralph --project . --plan <artifact-id> \
  --agent-provider codex --agent-model gpt-5.4-mini --agent-effort high \
  --manager-provider codex --manager-model gpt-5.6-sol --manager-effort high \
  --execution-unit task \
  --manager-audit exhaustive \
  --agent-first-output-timeout 300 \
  --manager-first-output-timeout 180 \
  --max-total-attempts 12 \
  --dashboard
```

O supervisor observa o grupo inteiro de processos. Em timeout, registra o
diagnóstico, envia SIGTERM aos descendentes e escala para SIGKILL. Ao término
normal também encerra helpers deixados pelo provider, evitando Vite, Vitest,
esbuild, servidores e sandboxes órfãos.

Quando o circuit breaker abre, o run fica `PAUSED`, preserva todos os prompts,
logs, evidências e o último motivo de retry e encerra com status 2. Executar o
mesmo comando novamente continua no próximo attempt durável.

## Locks e retomada após falta de energia

Cada run possui lock com PID do Ralph. Na inicialização, o runtime verifica:

- processo proprietário;
- dashboard;
- PIDs registrados dos providers;
- processos específicos daquele run.

Se existir qualquer processo vivo, o lock permanece exclusivo. Se todos
morreram, como após desligamento inesperado, o lock órfão é colocado em
quarentena e removido atomicamente antes da retomada. Evidências duráveis não
são apagadas.

## Aceitação operacional final

A fase runtime `RBF — Independent operational acceptance` é habilitada por
padrão. Ela não altera `PHASES.md`.

O Ralph procura `OPERATIONS.json` por flag, ambiente, ao lado do plano e em
paths canônicos da `.rb`. O contrato `rb-operational/v1` usa arrays de argumentos
em vez de strings de shell e pode declarar cenários para Linux, macOS e Windows.

Em cópia limpa do projeto, o Ralph pode testar:

- comandos e CLIs instalados;
- processos e readiness;
- HTTP, TCP e arquivos;
- bibliotecas por consumidor externo;
- plugins em host descartável;
- aplicações desktop/mobile por mecanismo observável real.

A cópia limpa exclui estado Git/runs, `.env`, dependências instaladas, produtos
de build e caches comuns. Um cenário que precisar deles deve recriá-los pelos
comandos declarados; Ralph não os herda silenciosamente da máquina local.

Sem contrato explícito, o RBF fica `BLOCKED`: o modelo não pode inventar uma
fronteira de aceitação operacional. Adicione um cenário `rb-operational/v1`
que exercite a entrada de consumidor documentada.

Desabilite apenas deliberadamente:

```bash
rb-ralph --project . --plan <artifact-id> --provider codex --no-final-audit
```

Se existir contrato operacional explícito, suas falhas continuam determinísticas
e não podem ser anuladas por aprovação do gerente.

## Disponibilidade e rate limit

```bash
rb-ralph --project . --plan <artifact-id> --provider codex \
  --rate-limit-wait 60 \
  --max-limit-waits 20 \
  --max-limit-wait 3600
```

Rate limit reconhecido repete a mesma tentativa lógica e não consome attempt de
implementação. Falhas de autenticação, saída inválida e erros comuns não são
tratados como indisponibilidade.

## Integração opcional com RB Memory

```bash
export RB_MEMORY_TOKEN="rbm_token-do-tenant"

rb-ralph --project . --plan <artifact-id> \
  --provider codex \
  --memory-url https://memory.exemplo.com/mcp
```

Com URL configurada, o modo padrão é `required`. Use
`--memory-mode best-effort` para continuar durante indisponibilidade ou
`--memory-mode off` para desativar. A memória é contexto consultivo; plano e
repositório atual sempre possuem maior autoridade.

## Evidências e integridade

Runs vivem em:

```text
.rb/runs/<artifact-id>-<sha12>/
```

O diretório contém eventos append-only, prompts, logs, snapshots, validações,
patches e decisões do gerente. Evidências existentes são verificadas por hash;
um executor não pode reescrever silenciosamente o plano de controle para provar
uma entrega inexistente.

O Ralph nunca cria commit visível, muda a branch atual ou faz push. Worktrees
paralelas podem criar objetos Git temporários internos, mas a integração ocorre
na árvore de trabalho e permanece sob controle do operador.

## Inspeção segura

```bash
rb-ralph --project . --list
rb-ralph --project . --plan <artifact-id> --dry-run
```

Esses comandos validam manifesto e plano sem criar `.rb/runs` e sem chamar IA.

## Testes do próprio Ralph

```bash
bash tests/test-portability-and-contract.sh
bash tests/test-execution-parallelism.sh
bash tests/test-agent-context.sh
bash tests/test-context-efficiency.sh
bash tests/test-validation-cache.sh
bash tests/test-authority-enforcement.sh
```

As suítes cobrem Bash 3.2, instalação e symlinks, paths com espaços, adapters,
gates fail-closed, dashboard, telemetria, retries, circuit breaker, retomada,
isolamento paralelo, conflitos de patch e cache incremental de validação.

## Limites deliberados

- Fases são sequenciais; somente tasks independentes da fase atual paralelizam.
- Isolamento por worktree aplica-se aos agentes paralelos.
- Adapters personalizados podem não fornecer telemetria normalizada.
- Estimativa de custo não modela todos os preços e condições comerciais.
- Espera por rate limit não transforma o Ralph em serviço agendador permanente.
- Detecção de progresso usa paths alterados e causas raiz do gerente; o teto
  absoluto continua sendo a última defesa contra mudanças que não convergem.
- Integração com RB Memory é opcional.
- O Ralph não publica commits nem envia alterações ao remoto.
