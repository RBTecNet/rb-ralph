# Auditoria completa de arquitetura, contratos e runtime do RB Ralph

Data da auditoria: 2026-08-26  
Árvore auditada: RB Ralph 0.10.1  
Commit inicial: de8911f024769e3e3ffd08c131bd87c80cd25390  
Natureza: diagnóstico somente; nenhuma remediação foi realizada.

## Executive Summary

O RB Ralph não garante hoje, de forma uniforme, as fronteiras de autoridade que seus contratos descrevem. Foram confirmados 18 defeitos arquiteturais: 2 CRITICAL, 12 HIGH e 4 MEDIUM. Os dois defeitos críticos permitem que uma execução termine em COMPLETE sem que o estado final do projeto corresponda à prova determinística registrada:

1. G3 ocorre depois de G2 e, nos caminhos em que o gerente pode escrever, ele pode alterar o produto já validado; Ralph não captura novo diff, não repete G2 e registra COMPLETE imediatamente.
2. O plano de controle protege somente arquivos já existentes em .rb/runs. Um executor pode introduzir um cache novo, cujo conteúdo não é autenticado, e fazer G2 reutilizar um exit code 0 fabricado.

As causas dominantes são sistêmicas:

- proibições materiais existem em prompts, mas não em uma fronteira de escrita do runtime;
- Scope participa da seleção incremental de validações, mas não é uma allowlist de escrita;
- a validade de G2 é definida pelo exit code do comando, sem identidade da implementação do teste, script, configuração, dependências ou ambiente;
- a identidade de cache e resume não inclui o estado completo que sustentou a prova;
- o gerente é simultaneamente modelo de julgamento e, em vários modos, processo com poder de mutação;
- os adapters dão significados diferentes a protected, enquanto YOLO é o padrão;
- a evidência canônica não cobre todas as classes de mudança e o controle de integridade ignora adições.

Respostas diretas às 18 perguntas obrigatórias:

| # | Resposta | Conclusão baseada em evidência |
| --- | --- | --- |
| 1 | PARTIALLY | Artefatos de especificação são protegidos por prompt e pelo provider; apenas patches paralelos em worktree os rejeitam deterministicamente. Em shared/sequencial não há bloqueio Ralph. |
| 2 | PARTIALLY | A prevenção é mecânica somente na integração paralela e em alguns tools/sandboxes. Nos demais caminhos é instrução ou cooperação do adapter. |
| 3 | NO | Nada no runtime impede uma escrita fora de Scope; G1 a enumera quando consegue, e o cache apenas cai para validação completa. |
| 4 | NO | Scope não é fronteira de implementação no runtime. É autoridade documental e hint mecânico de impacto do cache. |
| 5 | YES | Testes, assertions, fixtures, snapshots, scripts e configuração podem ser enfraquecidos antes de G2. |
| 6 | PARTIALLY | G1 pode mostrar o path, mas Ralph não classifica a redução de qualidade nem a rejeita; alguns paths nem entram no snapshot. |
| 7 | YES | O cache pode reutilizar prova após mudanças de repositório, HEAD, ambiente, testes ou configuração que não participam de sua chave/invalidação. |
| 8 | YES | Finding aceita fronteira, esperado e IDs extras sem vínculo mecânico com a autoridade original e é convertido em instrução imperativa de retry. |
| 9 | PARTIALLY | Um COMPLETE textual não vence o contador vermelho já calculado; porém o gerente pode mudar o estado depois de G2, e cache/evidência forjados podem tornar o contador falsamente verde. |
| 10 | YES | Findings estruturados podem fechar por omissão após mudança de fingerprint que não representa nova prova; o guard de mesma evidência não compara o formato persistido. |
| 11 | YES | Run ID usa apenas ID/hash do plano; fases COMPLETE e RBF podem ser reutilizadas depois de mudanças materiais no código e ambiente. |
| 12 | NO | Codex, Claude, OpenCode, APIs diretas e adapters custom expõem capacidades e overrides diferentes. |
| 13 | NO | YOLO é coerentemente amplo, mas protected não representa uma capacidade uniforme e pode ser enfraquecido por overrides ou ignorado por custom adapters. |
| 14 | PARTIALLY | Paralelo protege baseline, patches e colisão de path; não contém side effects externos nem conflito semântico entre arquivos distintos. Sequencial não usa worktree. |
| 15 | PARTIALLY | OPERATIONS explícito produz prova executável, mas seu validador diverge do contrato formal e a clean room pode copiar dependências/builds. Sem contrato, a prova é escolhida pelo modelo. |
| 16 | YES | Imutabilidade de especificações, write scope, disciplina do gerente, qualidade de teste e cenário RBF derivado dependem em parte de documentação/prompts. |
| 17 | YES | Faltam regressões diretas para write scope, mutação pelo gerente, greenwashing, cache forjado/obsoleto, resume após mudança de código, findings estruturados e equivalência real de permissões. |
| 18 | YES | Além dos sintomas, foram encontrados TOCTOU pós-G2, integridade incompleta de .rb/runs, fechamento incorreto de findings, parser ambíguo, drift do verificador operacional, identidade de resume insuficiente e riscos de segredo/evidência. |

Conclusão operacional: o estado COMPLETE significa que o fluxo observado satisfez os checks implementados, não que todas as garantias declaradas foram mecanicamente preservadas. Em especial, COMPLETE não sela o mesmo estado de repositório sobre o qual G1/G2 produziram evidência.

## Audit Scope

Foram inspecionados:

- contrato consolidado **../rb-harness/contracts/RB-RALPH-CONTRACT.md**, declarado como correspondente ao Ralph 0.8.11;
- contratos e schemas rb-manifest/v1, rb-execution/v1 e rb-operational/v1, inclusive validador empacotado;
- runtime 0.10.1 em **bin/rb-ralph**;
- **core/rb-harness.cjs** e fontes correspondentes em **../rb-harness/packages/core/src**;
- adapters Codex, Claude, OpenCode e API direta;
- providers de API direta OpenAI, Anthropic, Gemini, DeepSeek, MiniMax e OpenRouter, que compartilham o mesmo adapter/tool runtime;
- adapters custom por meio da interface agent-cmd/manager-cmd;
- **lib/manager-audit.cjs**, **validation-cache.cjs**, **operational-verifier.cjs**, **process-supervisor.cjs**, **control-plane.cjs**, **evidence.cjs**, **evidence-index.cjs** e auxiliares de contexto/fragmentos;
- prompts reais de executor, gerente, retry, strategy reset e RBF;
- worktree, integração de patches, run identity, resume, ledger de findings e evidência;
- README em inglês/português e três incidentes de 2026-08-26;
- os sete scripts de regressão em **tests/**.

Método:

- rastreamento de cada garantia normativa até o caller/callee que deveria aplicá-la;
- leitura separada de contrato, schema, runtime, prompt, adapter e teste;
- experimentos somente por stdin/process substitution para parsers e helpers;
- uma reprodução ponta a ponta em projeto temporário descartável, fora da árvore auditada, para confirmar a mutação pós-G2 pelo gerente;
- execução completa da suíte própria em temporários.

Todos os sete scripts de teste retornaram exit code 0. Entre os resultados: 99 checks em execution-parallelism, 246 em portability-and-contract, 6 em validation-cache e aprovação integral dos demais scripts. Esse resultado comprova os invariantes que os testes exercitam, não os invariantes ausentes descritos neste relatório.

O contrato consolidado informa versão 0.8.11 nas linhas 8-10, enquanto **VERSION:1** informa 0.10.1. Por isso, o contrato foi usado como fonte normativa inicial, mas a classificação final segue a implementação que efetivamente executa, conforme a própria regra das linhas 1069-1071 do consolidado.

## Actual Ralph Architecture

O fluxo efetivo é:

| Transição | Caller → callee | Entradas e autoridade | Estado mutável/persistido | Validação presente | Lacuna relevante |
| --- | --- | --- | --- | --- | --- |
| Descoberta | bin/rb-ralph → fragment-discovery/core | projeto, artifacts-dir, manifest, seleção de plano | temporários de descoberta | manifest/schema/contrato | não cria identidade para código/HEAD/ambiente |
| Preflight | bin/rb-ralph → core contract inspect/extract | plano validado | PHASES em memória; extratos sob .rb/runs | estrutura, IDs, dependências, validações | Scope é validado como texto limitado, não como capacidade de escrita |
| Run identity | bin/rb-ralph | artifact ID + SHA-256 do plano | .rb/runs/ID-hash12 | lock e arquivos iniciais | nenhuma identidade do repositório ou provider |
| Seleção | loop de fases/tasks | pending, depends, findings anteriores | task/phase extracts, attempts | dependências documentais | extratos futuros podem ser lidos de plano que executor alterou em shared |
| Prompt G0 | write_agent_prompt | task/fase, Context reduzido, findings e feedback | prompt canônico | budget de bytes | regras de proteção/scope são instruções |
| G0 | invoke_agent → adapter/provider | prompt, cwd do projeto ou worktree, permission mode | projeto/worktree, subprocessos, rede; log/submission | exit code, timeout; marcador em caso limitado | executor possui autoridade real maior que a task |
| G1 controle | control-plane snapshot/diff | somente STATE_DIR | diff de arquivos existentes | modificação/exclusão existente rejeitada | adições e projeto não são protegidos |
| G1 produto | evidence snapshot/diff | árvore do projeto antes/depois de G0 | changes JSON | hashes de arquivos regulares limitados | diretórios excluídos, mode bits, conteúdo externo de symlink e arquivos grandes |
| Seleção G2 | validation-cache select | tasks, validações, delta atual, cache | selection TSV | impacto por Scope; fallback quando delta atual é desconhecido | cache não autentica estado, origem nem arquivo |
| G2 | bash -lc ou operational-verifier | comando textual/OPERATIONS atual | projeto pode mudar por validação; logs/cache | exit code e timeout | teste/script/config podem ter sido alterados; sem captura pós-validação |
| Índice | evidence-index | changes, validation log, agent log | index JSON | parsing/cotas | narrativa/markers não são prova; índice não sela workspace |
| Prompt G3 | bin/rb-ralph | fase, matriz, changes, índice, workspace atual | prompt | enumeração esperada | manager delivery é instruído a ignorar defeitos fora dos critérios |
| G3 | invoke_manager → adapter/provider | mesma raiz primária | gerente pode ler e, em vários modos, escrever/executar | snapshot apenas de STATE_DIR existente | nenhuma recaptura do produto após o gerente |
| Parser/decisão | shell + manager-audit | stdout misturado do provider | audit JSON, reason, decision | matriz parcial/exaustiva conforme modo | duas interpretações do protocolo; evidência é texto livre |
| Findings | reconcile/ledger | findings do manager + fingerprint | findings.tsv | key normalizada; replay | closure depende de fingerprint incompleto e omissão de lote |
| Retry/reset | retrySelection/write_agent_prompt | rows/finding boundary/reason | nova task closure; feedback | mapeamento por IDs/Scope textual | finding pode criar autoridade e o prompt manda atender todos |
| COMPLETE | case decision | decision + contadores calculados antes de G3 | events, findings resolvidos, checkpoint | override de agent_rc/G2 red | aceita sem provar que o projeto ainda é o estado validado |
| Resume | last_phase_status | mesmo run ID | fases puladas, attempts/findings retomados | plano igual; RBF compara fingerprint operacional | código/HEAD/testes/contexto/ambiente não invalidam |
| RBF | fase sintética | OPERATIONS ou cenário derivado | executor pode corrigir produto; prova/log/manager | explícito: verifier; dinâmico: manager | sem contrato, G2 é skip; mudanças RBF não repetem validações normais |

Ordem real divergente mais importante: o contrato descreve G3 como auditor independente sobre evidência de G0-G2, mas o runtime permite que G3 altere o objeto auditado depois de G2. Não existe um quinto gate que compare o estado final ao estado evidenciado.

Fronteiras de confiança:

- confiável por desenho: plano que passou no core antes do run, contadores de exit code produzidos pelo processo do Ralph e patches integrados pelo próprio Ralph;
- não confiável, mas tratado parcialmente como estrutura: stdout do executor/gerente, evidence submissions, findings, reason, status markers;
- mutável por providers: projeto, testes, scripts, Git e, em YOLO, recursos externos acessíveis ao usuário;
- canônico sem autenticação completa: arquivos novos em .rb/runs, cache JSON, validation selection, audit report e índices;
- persistente: prompts, logs, events, findings, evidence, cache, patches e operational-accepted.

## Authority Model

O contrato consolidado define, nas linhas 21-45, plano validado → repositório → evidência canônica → narrativa. A implementação não possui um único mecanismo que imponha essa ordem em todas as transições.

| Fonte | Autoridade declarada | Autoridade efetiva | Pode ser sobreposta por |
| --- | --- | --- | --- |
| Task atual | unidade máxima de trabalho | conteúdo do prompt | finding do gerente, acesso amplo ao repositório, phase Context |
| Fase atual | agrupa task/context/validações | usada no manager e execution-unit phase | alterações no plano antes de extrações futuras |
| Scope | paths de implementação e impacto | tokens do cache/retry/context | qualquer ferramenta de escrita/comando |
| Change/Covers/AC | resultado requerido | texto para executor/manager | PASS/NA do gerente sem evidência tipada |
| Context | leitura necessária | contexto advisory incluído/aberto | pode induzir trabalho futuro; não há enforcement de somente leitura fora do provider |
| Repositório | realidade corrente | objeto mutável durante G0, G2 e G3 | executor, validação e gerente |
| Findings | defeito relativo à autoridade existente | instrução imperativa no retry | conteúdo livre do gerente não validado contra task |
| Executor narrative | advisory | markers e paths podem influenciar G0/G3 | apenas alguns checks mecânicos |
| G2 | prova determinística | exit code do comando resolvido no estado daquele instante | mudança da própria validação, cache e mutação posterior por G3 |
| Manager | auditor | policy engine e, em YOLO, possível desenvolvedor | overrides determinísticos pré-G3, mas não mutação pós-G2 |
| RBF | aceitação operacional final | contrato explícito ou cenário inventado por modelos | fraqueza do cenário, verifier divergente e reuso por fingerprint curto |

Classificação das expansões solicitadas:

| Situação | Classificação real |
| --- | --- |
| Executor introduzir requisito fora da task | proibido somente por instrução; não há write gate |
| Manager pedir refactor/requisito novo | proibido no prompt, aceito pelo parser e propagado |
| Retry ampliar Scope | possível por finding.boundary/expected e pelo comando “Address every open finding” |
| Strategy reset ampliar Scope | a frase pede estratégia diferente; não cria limite novo nem revalida findings, portanto depende de cooperação |
| Context induzir future work | possível; prompt declara autoridade, mas a capacidade de escrita não é limitada |
| Uma task implementar outra pendente | possível e observado no incidente tui_admin_samba |
| Finding anterior sobrepor task atual | possível: findings são injetados antes do extrato e tratados como obrigação cumulativa |

Proteção por categoria:

| Categoria | Shared/sequencial | Paralelo worktree | Protected | YOLO |
| --- | --- | --- | --- | --- |
| .rb/runs existente | detectado depois de G0/G3 | detectado depois; patch também rejeita .rb | mesma detecção | mesma detecção, após dano |
| .rb/runs novo | não protegido | patch rejeita se permanecer na worktree; escrita direta na árvore primária continua fora do patch gate | provider-dependent | irrestrito ao usuário |
| PHASES, manifest, artifacts, OPERATIONS, fragments | prompt/provider; G1 registra mas não rejeita | patch rejeitado por path | varia por provider/override | irrestrito |
| artifacts-dir alternativo | prompt; sem write gate | patch rejeita diretório selecionado | varia | irrestrito |
| Context fora do diretório de artifacts | sem proteção especial | somente colisão/path de artifacts | varia | irrestrito |
| Git metadata/config/hooks | invisível a G1 | worktree não contém side effects feitos no Git comum/externo | varia | irrestrito |
| Produto fora de Scope | permitido mecanicamente | patch permitido se não colidir/protegido | permitido dentro da sandbox do provider | irrestrito |

## G0-G3 Enforcement Matrix

| Gate | Garantia esperada | Enforcement real | Momento | Bypass/ausência | Teste negativo direto | Status |
| --- | --- | --- | --- | --- | --- | --- |
| G0 | executor implementa somente a task | prompt nas linhas 1035-1053 | antes | ferramentas não recebem allowlist de Scope | não | prompt/instruction only |
| G0 | artefatos Ralph imutáveis | prompt 1047-1049; provider sandbox | antes/cooperativo | shared YOLO, custom, shell de API direta | somente tamper de run existente | provider-dependent |
| G0 | exit não zero impede COMPLETE | linhas 3643-3645 | G3 | não foi encontrado bypass textual direto | sim | mechanically enforced |
| G0 | turno vazio/incompleto rejeitado | linhas 3274-3296 | após G1 | só built-in provider; marker é grep textual | parcial | partially enforced |
| G1 | todo delta relevante é capturado | evidence.cjs 28-118 | após G0 | exclusions, limite, mode bits, symlink target | não | partially enforced |
| G1 | plano de controle imutável | control-plane.cjs 24-76 | após provider | só arquivos existentes; additions ignoradas | só modificação existente | contradicted |
| G1 | mudança fora de Scope rejeitada | inexistente | nunca | todas as categorias ordinárias | não | documentation only |
| G1 | artefato de planejamento rejeitado | integrate_worktree_changes 1659-1691 | apenas paralelo | shared/sequencial não chama esse gate | paralelo sim | mode-dependent |
| G2 | comando vermelho não vira COMPLETE | linhas 3646-3648 | depois do manager output | vale apenas para contador calculado antes de G3 | sim | mechanically enforced no snapshot pré-G3 |
| G2 | comando ainda representa a validação declarada | inexistente | nunca | testes/scripts/config/deps mutáveis | não | documentation only |
| G2 | cache verde é prova autêntica e atual | cache key command-only; JSON confiado | seleção | forge e stale state | não | contradicted |
| G3 | gerente apenas audita | prompt + provider mode | durante | YOLO/custom/overrides podem escrever | não | provider-dependent |
| G3 | matriz exatamente uma por ID | manager-audit 205-280 | após output | rows sim; decision/status/reason não são únicos; NA/evidência livres | parcial | partially enforced |
| G3 | não cria requisitos | somente prompt | durante/retry | finding livre e propagado | não | documentation only |
| G3 | decisão refere-se ao mesmo estado de G2 | inexistente | após G3 | manager pode alterar projeto | não; reprodução confirmou | contradicted |
| COMPLETE | todos gates verdes no estado final | contadores pré-G3 + decision | final | sem seal/recaptura/revalidação | não | contradicted |

## Contract vs Runtime Matrix

| Guarantee | Contract | Schema | Runtime | Provider dependent | Prompt dependent | Tests | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Manifest e plano são validados antes do provider | sim | sim | core inspect/preflight | não | não | sim | ENFORCED |
| Scope contém paths de implementação | sim | forma textual parcial | sem write gate | sim | sim | não | CONTRADICTED |
| .rb e artefatos gerados são imutáveis | sim, linhas 230-232 | rejeita Scope/Change explícitos | rejeição só no patch paralelo | sim | sim | parcial | PARTIALLY_ENFORCED |
| Context é autoridade de leitura, não de escrita | sim | apenas presença | sem boundary | sim | sim | não | DOCUMENTATION_ONLY |
| Cada task recebe contexto novo | sim | n/a | nova chamada por padrão task | provider pode manter estado externo | não | sim | PARTIALLY_ENFORCED |
| G0 exit não zero vence manager | sim | n/a | override em 3643-3645 | não | não | sim | ENFORCED |
| Marker COMPLETE distingue turno vazio | sim | n/a | somente built-in/no delta | sim | não | parcial | PARTIALLY_ENFORCED |
| G1 captura added/modified/deleted | sim | schema interno | arquivos cobertos pelo snapshot | não | não | sim | PARTIALLY_ENFORCED |
| Renames são observados | implícito | n/a | aparecem como add/delete | não | não | parcial | ENFORCED |
| Binários paralelos são preservados | sim | n/a | git diff --binary | não | não | sim | ENFORCED |
| Arquivos grandes, modes e dirs excluídos são cobertos | necessário | não | omitidos/limitados | não | não | não | CONTRADICTED |
| Control-plane existente é imutável | sim | n/a | hash e rejeição pós-provider | não | não | sim | ENFORCED |
| Control-plane novo não pode ser forjado | implícito/necessário | não | additions ignoradas | não | prompt para executor | não | CONTRADICTED |
| Validação tem uma autoridade Ralph | sim | comando validado parcialmente | bash -lc/exit code | não | não | sim | PARTIALLY_ENFORCED |
| Determinístico vermelho vence COMPLETE | sim | n/a | contador pré-G3 vence | manager write depende do provider | não | sim | PARTIALLY_ENFORCED |
| Teste/comando não pode ser enfraquecido | necessário | só masks óbvios | sem integridade semântica | não | respeito a testes | não | DOCUMENTATION_ONLY |
| Cache reutiliza somente prova ainda válida | sim | schema interno fraco | key kind+command e delta atual | não | não | happy path | CONTRADICTED |
| Manager é independente e não implementa | sim, linhas 542-545 | n/a | processo separado, mas pode escrever | sim | sim | não | PARTIALLY_ENFORCED |
| Exatamente uma criterion row por ID | sim | parser interno | rows duplicadas/missing rejeitadas | não | sim | parcial | ENFORCED |
| Exatamente um status/decision/reason válido | sim, linhas 603-610 | não | dois parsers, last-match, sem unicidade | não | sim | não | CONTRADICTED |
| FAIL/UNPROVEN exige finding | sim | parser interno | checagem por string de criteria | não | sim | parcial | PARTIALLY_ENFORCED |
| COMPLETE só PASS/NA | sim | parser interno | sim, mas NA/evidência são livres | não | sim | parcial | PARTIALLY_ENFORCED |
| Finding não cria autoridade | necessário | não | boundary/expected/criteria livres | não | sim | não | DOCUMENTATION_ONLY |
| Finding aberto não fecha com mesma prova | sim | não | formatos de fingerprint incompatíveis | não | não | teste só legacy | CONTRADICTED |
| Retry preserva task boundary | sim | não | mapeamento parcial + finding imperativo | não | sim | localização happy path | PARTIALLY_ENFORCED |
| Run identity invalida prova materialmente obsoleta | necessário | não | somente plan ID/hash | não | não | plano apenas | CONTRADICTED |
| RBF muda quando contrato/runtime muda | sim | n/a | version + operations hash/dynamic-v1 | não | não | contrato sim | PARTIALLY_ENFORCED |
| Paralelo usa baseline comum e rejeita mesmo path | sim | n/a | snapshot/worktrees/patch check | OS sandbox ainda provider | não | sim | ENFORCED |
| Paralelo detecta conflito semântico entre paths | necessário | não | depende de G2/G3 | sim | sim | não | UNPROVEN |
| protected tem semântica uniforme | sim como política | não | adapters divergentes/overrides | sim | não | flags apenas | CONTRADICTED |
| API direct manager é observacional | sim | tool schema | tools read-only, sem command/write | provider só decide calls | instrução reforça | inspeção parcial | ENFORCED |
| OPERATIONS formal é validado pela mesma autoridade | sim | schema/core | Ralph usa verifier mais fraco | não | não | caso válido/falha | CONTRADICTED |
| Clean room não reutiliza deps/build/local state | sim | exclusions configuráveis | defaults copiam vários desses dirs | não | prompt | parcial | CONTRADICTED |
| RBF dinâmico cruza fronteira real | sim | não | escolha do executor/manager | sim | sim | caso feliz | UNPROVEN |
| Segredos não entram em prompt/evidência | sim | filtros parciais | logs/stdout sem redaction geral | sim | sim | .env apenas | PARTIALLY_ENFORCED |
| Documento consolidado corresponde ao runtime | sim | n/a | documento diz 0.8.11; runtime 0.10.1 | não | não | não | CONTRADICTED |

## Confirmed Findings

### RALPH-AUDIT-001 — O gerente pode invalidar G2 e ainda concluir a fase

- **Severity:** CRITICAL
- **Confidence:** CONFIRMED
- **Category:** manager / validation / authority
- **Contract Expectation:** o gerente é auditor independente, não implementa; COMPLETE exige gates determinísticos verdes sobre o produto aceito.
- **Actual Implementation:** G2 termina nas linhas 3314-3410. Depois, invoke_manager roda no PROJECT. O snapshot das linhas 3555-3576 cobre somente STATE_DIR. O branch COMPLETE das linhas 3674-3690 persiste aceitação sem novo snapshot do projeto, G1 ou G2.
- **Evidence:** **bin/rb-ralph:3314-3410, 3555-3576, 3643-3653, 3674-3690** e **README.md:1175-1178**. Reprodução isolada: executor escreveu “valid”; G2 executou teste exato e registrou exit=0; manager custom escreveu “corrompido-pelo-gerente” e devolveu matriz exhaustive COMPLETE; Ralph saiu 0, events.tsv registrou P01 COMPLETE e o arquivo final permaneceu corrompido.
- **Root Cause:** não existe vínculo imutável entre o snapshot/prova de G2 e o estado aceito depois de G3; o papel “auditor” é uma instrução, não uma capacidade.
- **Impact:** COMPLETE pode coexistir com código, testes ou configuração nunca validados, inclusive estado conhecido como inválido.
- **Affected Modes:** manager CLI/custom em YOLO; protected quando override ou adapter permite escrita. Não afeta o manager de API direta, cujos tools são read-only.
- **Existing Detection:** somente alteração/exclusão de arquivo já existente em .rb/runs é detectada; mutação do produto pelo gerente não é.
- **Gate Analysis:** G0/G1/G2 podem passar corretamente; G3 muda o objeto depois deles; o branch final não reabre G1/G2.
- **Required Property:** o estado que recebe COMPLETE deve ser exatamente o estado sobre o qual a evidência canônica e todas as validações aplicáveis foram produzidas, e G3 deve ser incapaz de modificá-lo.

### RALPH-AUDIT-002 — Adições ao plano de controle permitem forjar o cache determinístico

- **Severity:** CRITICAL
- **Confidence:** CONFIRMED
- **Category:** control-plane / cache / evidence
- **Contract Expectation:** .rb/runs é orchestrator-owned; executor não pode fabricar evidência canônica; cache verde deve derivar de execução registrada.
- **Actual Implementation:** **control-plane.cjs:24-47** ignora symlinks/non-files e cria mapa dos arquivos existentes; **62-76** compara apenas entries anteriores, sem array added. O cache previsível **Pxx-validation-cache.json** é lido como JSON confiável; **validation-cache.cjs:51-61, 105-137** verifica somente contract, key de kind+command e exitCode 0.
- **Evidence:** **bin/rb-ralph:3075-3079, 3170-3184, 3337-3373**. Experimento não mutante do helper forneceu cache construído externamente para test-b com exitCode 0/evidence “forjado”; com alteração somente em src/a, select retornou T002 command test-b reuse. A composição do runtime permite criar esse arquivo novo durante G0 sem CONTROL_PLANE_VIOLATION.
- **Root Cause:** integridade é definida como “arquivos anteriores não mudaram”, não como allowlist de artefatos que só o orchestrator pode criar; o cache não tem proveniência autenticada.
- **Impact:** uma validação que nunca executou pode aparecer em G2 como exit 0 reutilizado e permitir COMPLETE geral.
- **Affected Modes:** shared/sequencial YOLO, custom permissivo e qualquer provider capaz de escrever .rb/runs; worktree reduz a escrita que permanece no patch, mas não contém comandos capazes de alcançar a árvore primária.
- **Existing Detection:** nenhuma para a primeira criação; mutações posteriores do mesmo arquivo passam a ser detectáveis.
- **Gate Analysis:** G0 cria o artefato; G1 do projeto exclui .rb/runs; G1 control-plane ignora added; G2 confia; G3 recebe linha verde.
- **Required Property:** somente o orchestrator deve poder criar ou substituir cada artefato canônico, e toda reutilização deve provar origem, conteúdo e estado de validade.

### RALPH-AUDIT-003 — Especificações protegidas são mutáveis em shared/sequencial

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** authority / scope / control-plane
- **Contract Expectation:** contrato consolidado 230-232 torna .rb, .rb/** e todo artefato gerado imutáveis.
- **Actual Implementation:** prompt 1047-1049 pede para não editar. O único path gate Ralph está em **changes_touch_protected_artifacts**, linhas 1659-1691, chamado durante integração paralela. Agentes sequenciais recebem PROJECT diretamente nas linhas 3137-3167.
- **Evidence:** **bin/rb-ralph:1025-1090, 1659-1691, 3137-3167, 3256-3259**; **README.md:238-240, 1435-1436**. G1 registra mudanças comuns em .rb, mas não as transforma em failure.
- **Root Cause:** “conceitualmente read-only” foi implementado como política de prompt/provider e como filtro de patch de um modo específico, não como invariante do runtime.
- **Impact:** executor pode alterar PHASES, manifest, artifacts.tsv, OPERATIONS, fragments, Context ou artifacts-dir alternativo. Extrações de tasks/fases futuras podem então consumir autoridade substituída sem nova validação do plano.
- **Affected Modes:** shared, sequencial, execution-unit phase/task, YOLO; protected depende do provider. Paralelo worktree rejeita o delta por path, salvo side effects fora da worktree.
- **Existing Detection:** G1 pode listar o path e G3 pode rejeitar voluntariamente; dano já ocorreu e não há rollback em shared.
- **Gate Analysis:** G0 só instrui; G1 observa sem policy; G2 executa validações do plano previamente extraídas ou indiretamente alteradas; G3 default delivery não é deterministicamente obrigado a rejeitar.
- **Required Property:** artefatos que definem autoridade devem ser imutáveis em todos os modos e qualquer violação deve ser prevenida ou rejeitada com restauração comprovada antes de continuar.

### RALPH-AUDIT-004 — Scope não limita escrita e trabalho alheio pode sobreviver

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** scope / authority
- **Contract Expectation:** Scope é a fronteira de implementação da task e scope expansion não pode ocorrer implicitamente.
- **Actual Implementation:** o core valida presença/backticks e alguns valores amplos em **execution-contract.ts:283-329, 458-477**. O runtime usa Scope em context, retry selection e **validation-cache.cjs:70-103**, mas nunca compara changed paths com a task executada para rejeitar escrita.
- **Evidence:** **README.md:1342-1349** descreve fallback completo, não rejeição. **bin/rb-ralph:3256-3259** apenas calcula diff. **test-manager-review.sh:76-85** exige que delivery não abra findings fora dos critérios. O incidente **docs/incidents/2026-08-26-tui_admin_samba-nonconvergent-plan.md** documenta T001 concluída por alteração em internal/app/app.go fora de Scope, antecipando T038.
- **Root Cause:** a mesma palavra Scope é usada para autoridade documental e otimização de impacto, mas só a segunda semântica tem código.
- **Impact:** mudanças em source, tests, package scripts, dependencies, lockfiles, CI, build config, fixtures, schemas, migrations ou arquivos de outra task podem permanecer até COMPLETE.
- **Affected Modes:** todos; worktree rejeita colisão/protected path, não out-of-scope.
- **Existing Detection:** path fora de todos os scopes força full validation cache; manager pode notar. Nenhum gate o proíbe.
- **Gate Analysis:** G0 prompt; G1 inventário; G2 fallback pode ficar verde; G3 delivery é instruído a ignorar defeitos não declarados.
- **Required Property:** cada execução deve possuir um conjunto de escrita autorizado derivado da task, e qualquer expansão deve exigir autoridade explícita e auditável.

### RALPH-AUDIT-005 — G2 pode ser greenwashed pela alteração da própria prova

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** validation
- **Contract Expectation:** validação determinística deve provar o comportamento requerido, e não apenas produzir exit 0.
- **Actual Implementation:** comando textual é executado por **bash -lc** em **bin/rb-ralph:3361-3369**. O parser do core bloqueia apenas masks evidentes em **execution-contract.ts:100-120**. Não há baseline/integridade para testes, package.json, Makefiles, configs, fixtures, snapshots, mocks, feature flags ou dependências.
- **Evidence:** o command string é extraído antes do executor, mas suas dependências indiretas são workspace mutável. **README.md:1363-1366** admite que validation-mode manager desliga a autoridade de comandos. Nenhum teste Ralph altera assertion/script/config para comprovar rejeição.
- **Root Cause:** G2 modela “processo terminou em zero”, não “mecanismo de prova permaneceu equivalente ao aprovado”.
- **Impact:** executor pode remover/skipar testes, enfraquecer assertions, atualizar snapshots, trocar mocks, reduzir test selection ou redefinir npm test e fabricar verde.
- **Affected Modes:** validation-mode run para manipulação indireta; manager mode remove completamente o gate de comandos normais. OPERATIONS explícito continua aplicável ao RBF.
- **Existing Detection:** G1 pode listar arquivos não excluídos e G3 pode interpretar; nenhuma classificação determinística de redução de prova existe.
- **Gate Analysis:** G0 não proíbe explicitamente todas as formas de test gaming; G1 não rejeita; G2 aceita zero; G3 delivery aceita outcome “evidenced”.
- **Required Property:** uma prova só pode ser aceita se o mecanismo, seleção, fixtures, configuração e dependências relevantes permanecerem dentro da autoridade e identidade aprovadas.

### RALPH-AUDIT-006 — Cache não identifica o estado que tornou a validação verde

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** cache / validation
- **Contract Expectation:** reuso incremental deve provar que nenhuma premissa da validação mudou.
- **Actual Implementation:** key é SHA-256 de kind + NUL + command em **validation-cache.cjs:51-53**. Invalidação usa somente changed paths do attempt atual e Scope das tasks pendentes, linhas 70-137. Não inclui content tree, HEAD, tests, config, scripts, lockfile, environment, toolchain, generated code, Context, provider ou runtime.
- **Evidence:** cache JSON persiste por fase em **bin/rb-ralph:3337-3373**. Mudança feita antes do snapshot do attempt não aparece no delta atual. **test-validation-cache.sh:14-58** cobre dedup, impacto e fallback, mas não mudança de estado externo.
- **Root Cause:** invalidation é baseada em delta local do executor, enquanto validade é propriedade de todo o estado de dependência da prova.
- **Impact:** resultado verde anterior pode ser reutilizado depois de alteração relevante e permitir COMPLETE sem nova execução.
- **Affected Modes:** validation-mode run após primeira gravação, shared/worktree, retries/resume no mesmo run.
- **Existing Detection:** plano alterado cria outro run; path fora de Scope no delta atual força full. Isso não cobre mudanças anteriores ou omitidas.
- **Gate Analysis:** G1 vê apenas G0 atual; G2 seleciona reuse; G3 recebe exit 0 reused; nenhum gate conhece premissas históricas.
- **Required Property:** cache key/invalidation deve abranger toda entrada material da validação e provar continuidade entre o estado gravado e o reutilizado.

### RALPH-AUDIT-007 — Run identity e resume reutilizam prova após mudança material

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** resume / evidence
- **Contract Expectation:** evidência só pode ser reutilizada enquanto suas premissas permanecerem válidas.
- **Actual Implementation:** RUN_ID é plan ID + 12 chars do plan hash em **bin/rb-ralph:2885-2890**. Fase com último status COMPLETE é pulada em 2931-2945. RBF compara somente Ralph version + operations hash, ou version + dynamic-v1, em 2829-2836.
- **Evidence:** nenhuma comparação de HEAD, source tree, tests, Context, requirements, locks, validation scripts, env, models ou config ocorre no branch resume. **README.md:503, 1173** promete resume pelo mesmo plan hash, confirmando o comportamento, mas essa identidade é insuficiente para prova.
- **Root Cause:** identidade de execução representa o contrato selecionado, não o estado factual sobre o qual a aceitação foi emitida.
- **Impact:** fases e aceitação operacional podem continuar COMPLETE após regressão, mudança de branch/HEAD, dependência, configuração ou entrada pública.
- **Affected Modes:** todos os resumes; RBF explícito só invalida por conteúdo de OPERATIONS/version, dinâmico apenas version.
- **Existing Detection:** manifest pode rejeitar artifact listado com hash inconsistente; não cobre o produto e demais inputs.
- **Gate Analysis:** gates não rodam para fase pulada; não há oportunidade posterior de detectar stale proof.
- **Required Property:** toda evidência retomável deve possuir identidade material do estado e ser invalidada por qualquer mudança capaz de afetar sua conclusão.

### RALPH-AUDIT-008 — Findings do gerente podem criar autoridade de implementação

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** manager / authority / retry
- **Contract Expectation:** finding descreve defeito relativo a task/AC existente; não introduz refactor, requisito ou fronteira nova.
- **Actual Implementation:** **manager-audit.cjs:228-235** aceita criteria, boundary, expected, observed e evidence como strings. Unknown IDs são rejeitados apenas nas criterion rows, não dentro de finding. **retrySelection:294-346** usa os strings para escolher tasks/dependências. **bin/rb-ralph:1061-1065** manda o executor atender todo finding aberto.
- **Evidence:** experimento por process substitution com finding “T001,FUTURE-T999”, boundary fora de Scope e expected de refactor foi retornado valid=true/issues=[] pelo helper. O prompt de retry preserva todo o texto como obrigação.
- **Root Cause:** o parser valida forma, não derivação de autoridade; observação do modelo é convertida diretamente em comando.
- **Impact:** manager pode solicitar outra task, refactor ou mudança de arquitetura e o executor recebe autorização de facto.
- **Affected Modes:** exhaustive e qualquer provider; legacy é ainda menos estruturado. Strategy reset mantém esses findings.
- **Existing Detection:** localização pode cair em fallback quando nada mapeia; um finding que também cita ID válido passa e continua amplo.
- **Gate Analysis:** G3 cria o finding; retry injeta; G0 da tentativa seguinte o trata como obrigatório; G1/G2 não aplicam Scope.
- **Required Property:** retry só pode transmitir defeitos demonstravelmente derivados da autoridade original, sem ampliar paths, requisitos ou dependências.

### RALPH-AUDIT-009 — Finding estruturado pode fechar sem nova prova válida

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** findings / evidence / resume
- **Contract Expectation:** finding permanece aberto até mudança relevante, nova evidência canônica ou waiver autorizado; mesma prova não pode fechá-lo.
- **Actual Implementation:** findings estruturados guardam opened evidence como fingerprint:reasonHash em **manager-audit.cjs:192-199**. **open_finding_has_same_evidence**, em **bin/rb-ralph:870-875**, compara a coluna inteira ao fingerprint nu, portanto não encontra o formato estruturado. **reconcile:174-190** fecha finding ausente quando o fingerprint-base difere.
- **Evidence:** fingerprint em **bin/rb-ralph:848-867** cobre somente delta do attempt + validation log, não o estado completo. O teste de same evidence em **test-portability-and-contract.sh:1404-1433** roda sob audit mode legacy definido nas linhas 89-90. O teste exhaustive **test-execution-parallelism.sh:433-440** afirma que finding omitido fecha após mudança de fingerprint.
- **Root Cause:** formatos incompatíveis e fingerprint de evento/delta usado como se fosse identidade do estado/prova.
- **Impact:** defeito não resolvido pode desaparecer do ledger e deixar de bloquear COMPLETE.
- **Affected Modes:** exhaustive findings em retries/resume.
- **Existing Detection:** replay é idempotente sobre os audits que possui, mas reproduz a mesma regra de closure; malformed audit é retry, não proteção contra omissão válida.
- **Gate Analysis:** G3 omite/renomeia; reconcile fecha; próximo G0 não recebe finding; branch COMPLETE resolve todos.
- **Required Property:** closure deve exigir prova positiva vinculada ao finding e identidade do estado, nunca mera ausência em lote ou mudança incidental de fingerprint.

### RALPH-AUDIT-010 — Parser G3 aceita decisões e evidências insuficientes

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** manager / evidence / contract-drift
- **Contract Expectation:** uma autoridade única normaliza protocolo, exige exatamente uma decisão/status/reason e evidência canônica por row; COMPLETE só após audit exaustivo real.
- **Actual Implementation:** **manager-audit.cjs:205-280** sobrescreve status/decision a cada match, não exige unicidade, não valida decision enum isoladamente e aceita qualquer evidence não vazia. Todas as rows podem ser NOT_APPLICABLE. O shell usa outro parser e escolhe o último decision válido em **bin/rb-ralph:3610-3618**.
- **Evidence:** fixture em stdin com task e AC como NOT_APPLICABLE, evidência “sem prova canônica” e duas decisions RETRY/COMPLETE retornou valid=true e COMPLETE. Finding com ID extra também foi valid. O incidente **happy_mrs_chicken-manager-protocol.md** demonstra divergência prática de whitespace/estado; o runtime atual ainda usa as duas interpretações.
- **Root Cause:** protocolo textual permissivo, duplicado entre Node e shell, sem schema de evidência ou semântica de NA.
- **Impact:** G3 pode aprovar critérios não provados, outputs contraditórios ou manual validations apenas declaradas.
- **Affected Modes:** exhaustive; legacy dispensa toda matriz. Todos os providers podem produzir as formas.
- **Existing Detection:** missing/duplicate criterion rows e FAIL/UNPROVEN sem finding são rejeitados; isso não cobre os casos acima.
- **Gate Analysis:** G0-G2 podem não possuir prova para manual/manager mode; G3 fabrica PASS/NA estruturalmente válido; COMPLETE é aceito.
- **Required Property:** uma gramática única deve produzir decisão inequívoca e cada status deve ter evidência tipada, autorizada e verificável.

### RALPH-AUDIT-011 — Protected não é uma fronteira equivalente entre providers

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** permissions
- **Contract Expectation:** permission mode deve ter significado previsível; adapter incapaz de protected deve falhar.
- **Actual Implementation:** YOLO é default em **bin/rb-ralph:152-154** e README 1095-1110. Codex protected usa workspace-write/read-only, mas variáveis podem escolher danger-full-access (**adapters/codex.sh:23-74**). Claude aceita override bypassPermissions (**claude.sh:22-68**). OpenCode protected define deny somente para manager; agent fica no default do provider (**opencode.sh:22-68**). Custom recebe apenas env. API direta rejeita agent protected, mas seu YOLO run_command aceita argv bash -c e env do processo (**api-agent-tools.ts:244-257, 266-274, 412-420**).
- **Evidence:** **bin/rb-ralph:769-777**, **README.md:1138-1147**. Manager de API direta é exceção positiva: tools de manager são read-only em **api-agent-tools.ts:214-221** e system instruction 185-200.
- **Root Cause:** permission mode é sinal de configuração, não capability contract verificado pelo Ralph.
- **Impact:** operador pode supor proteção que depende de versão/config/provider; custom adapter pode ignorá-la; executor/manager podem acessar shell, subprocessos, Git, rede ou diretórios externos.
- **Affected Modes:** diferenças em todos; maior risco em YOLO, OpenCode protected agent, overrides e custom.
- **Existing Detection:** direct API agent protected falha; demais adapters validam token, não capacidade efetiva.
- **Gate Analysis:** permissões definem o poder antes de G0/G3; gates posteriores não cobrem side effects externos e não restauram dano.
- **Required Property:** cada role/mode deve declarar e demonstrar capacidades uniformes, e Ralph deve falhar quando a capacidade mínima não puder ser garantida.

### RALPH-AUDIT-012 — G1 não captura toda mudança capaz de afetar aceitação

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** evidence / control-plane
- **Contract Expectation:** G1 fornece ao manager o delta completo relevante e suporta decisões de scope/cache.
- **Actual Implementation:** **evidence.cjs:8-12** exclui .git, node_modules, vendor, dist, build, coverage, .next, target e .cache; limita 20 mil arquivos/8 MiB; **42-49** hasheia somente texto do target de symlink; **59-65** não inclui mode bits.
- **Evidence:** **evidence.cjs:94-118** compara hashes de conteúdo. G1 roda uma vez após executor em **bin/rb-ralph:3256-3259**, antes de validação e manager.
- **Root Cause:** snapshot otimizado para contexto foi reutilizado como evidência de integridade/impacto.
- **Impact:** alteração em dependency tree, build output, Git hooks/config, executable bit, arquivo grande ou target externo pode afetar G2/produto sem aparecer nos changed paths.
- **Affected Modes:** todos; paralelo tem Git patch adicional para delta da worktree, mas evidência/manager/cache continuam usando o snapshot limitado e side effects externos permanecem.
- **Existing Detection:** limitations de tamanho/contagem são registradas e forçam cache conservador; exclusions/mode/target externo não.
- **Gate Analysis:** G1 omite; G2 pode usar estado omitido; G3 não recebe path; resume/cache não o identificam.
- **Required Property:** toda entrada mutável capaz de afetar execução ou prova deve ser coberta, explicitamente imutável, ou marcada como premissa não comprovada que bloqueia reuso/aceitação.

### RALPH-AUDIT-013 — Verificador operacional diverge do contrato formal e da clean room prometida

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** operational / contract-drift
- **Contract Expectation:** OPERATIONS segue rb-operational/v1 formal e executa sem deps, builds, local state ou segredos não declarados.
- **Actual Implementation:** Ralph usa **lib/operational-verifier.cjs** em 2829-2830 e 3330. Seu validator 60-118 não rejeita unknown properties nem IDs de step duplicados que o core/schema rejeita. Defaults de exclusão, linhas 14-16 e 355-366, removem .git, .rb/runs e alguns .env, mas copiam node_modules, vendor, dist, build, target e outros estados se o contrato não os listar.
- **Evidence:** o mesmo JSON com root property desconhecida e dois steps com ID x retornou VALID no operational-verifier e foi rejeitado por **core/rb-harness.cjs operations validate** por unknown property e duplicate step ID. **README.md:569-572** transfere exclusões adicionais ao autor, enquanto o prompt RBF afirma não depender desses artefatos.
- **Root Cause:** Ralph mantém validator próprio mais fraco e defaults de cópia incompatíveis com a afirmação de clean room.
- **Impact:** contrato formalmente inválido ou fluxo dependente de deps/build/local state pode produzir PASS operacional.
- **Affected Modes:** RBF com OPERATIONS explícito, todas as plataformas aplicáveis.
- **Existing Detection:** path traversal em cwd/file e symlinks externos são rejeitados; exit/probes são checados.
- **Gate Analysis:** G2 trata o verifier como autoridade determinística; G3 é instruído a confiar no resultado; nenhum gate compara com o schema empacotado.
- **Required Property:** a prova operacional deve usar a mesma semântica formal publicada e uma clean room cuja ausência de artefatos não declarados seja demonstrável.

### RALPH-AUDIT-014 — RBF dinâmico pode provar um cenário fraco e alterar produto sem regressão normal

- **Severity:** HIGH
- **Confidence:** CONFIRMED
- **Category:** operational / manager / validation
- **Contract Expectation:** RBF cruza a fronteira real do consumidor e detecta defeitos escapados.
- **Actual Implementation:** sem OPERATIONS, G2 marca skip/delegado em **bin/rb-ralph:3333-3335, 3402-3403**. O executor/manager escolhem o cenário por prompt 2950-2987. O executor RBF também é autorizado a corrigir código/documentação; validações normais de fases COMPLETE não são repetidas.
- **Evidence:** incidente **2026-08-26-atravessar-a-rua-visual-false-positive.md**: RBF e manager usaram Chrome, mas verificaram presença/estado, sem screenshot, geometry ou computed style, e concluíram UI inutilizável. O índice não diferenciou manual instruction de execução.
- **Root Cause:** significado de “menor cenário honesto” e suficiência da fronteira são decisões do modelo sem contrato executável/evidência tipada.
- **Impact:** fluxo trivial ou não representativo pode encerrar o produto; reparo RBF pode introduzir regressão fora das validações anteriores.
- **Affected Modes:** ausência de OPERATIONS; também explicit RBF quando contrato cobre apenas cenário estreito.
- **Existing Detection:** manager RBF usa review depth code e prompt forte; não há gate semântico.
- **Gate Analysis:** G0 inventa/executa cenário e pode editar; G1 captura parte do delta; G2 skip; G3 avalia sua própria interpretação; COMPLETE persiste dynamic-v1.
- **Required Property:** aceitação final deve ter cenário autorizado e observáveis duráveis vinculados ao entrypoint/capacidade pública, além de cobrir regressões introduzidas no RBF.

### RALPH-AUDIT-015 — Isolamento paralelo é lexical e não equivale ao sequencial

- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** parallelism / isolation
- **Contract Expectation:** execução paralela preserva os mesmos invariantes e integra resultado combinado seguro.
- **Actual Implementation:** **integrate_worktree_changes:1669-1734** usa baseline comum, mesmo-path ownership, git apply --check e binary patches. Alterações em paths distintos não recebem análise semântica. Worktree só é criado quando use_parallel=1, linhas 3085-3105; sequencial usa PROJECT, 3137-3167, mesmo com isolation=worktree.
- **Evidence:** **test-execution-parallelism.sh:618-689** cobre worktree obrigatório, baseline, conflicts e overlap, mas não contrato/consumidor em arquivos distintos. **README.md:1435-1436** documenta o limite sequencial.
- **Root Cause:** isolamento é integração de patch, não sandbox nem análise de dependência comportamental.
- **Impact:** tasks podem ser lexicalmente disjuntas e semanticamente incompatíveis; comandos YOLO podem produzir side effects fora da worktree.
- **Affected Modes:** paralelo worktree; sequencial permanece shared.
- **Existing Detection:** G2 da fase e G3 podem encontrar conflito se a validação/cobertura for suficiente.
- **Gate Analysis:** G0 isolado por árvore; G1/G2 veem combinado; G3 depende de prova; não há gate específico para conflito semântico.
- **Required Property:** o estado combinado deve ser validado contra dependências/invariantes compartilhados, e “isolation” deve ter semântica explícita por modo.

### RALPH-AUDIT-016 — G0 não possui protocolo uniforme de conclusão

- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** executor / provider
- **Contract Expectation:** turno vazio, incompleto ou malformado não deve chegar a G3 como implementação concluída.
- **Actual Implementation:** **bin/rb-ralph:3274-3296** exige no-change + ausência do marker apenas quando AGENT_PROVIDER é não vazio. Custom adapter com exit 0 não passa pelo check. Marker é grep de substring no log e não prova que foi a resposta final após todas as tools.
- **Evidence:** condição explícita nas linhas 3274-3276; prompt 1053 pede linha exata, mas parser não a associa à posição/finalização.
- **Root Cause:** semântica de completion depende da origem do adapter e de texto não estruturado.
- **Impact:** execução vazia/parcial pode gastar G3 e, combinada com G2 manager/manual e parser permissivo, concluir sem entrega.
- **Affected Modes:** custom principalmente; built-ins podem incluir marker incidental.
- **Existing Detection:** agent exit, timeout, G1, G2 e manager ainda podem rejeitar.
- **Gate Analysis:** G0 classifica de modo desigual; gates posteriores não sabem se a tool turn terminou realmente.
- **Required Property:** todos os adapters devem produzir uma conclusão estruturada, inequívoca e vinculada ao fim da execução.

### RALPH-AUDIT-017 — Documento consolidado e runtime não têm versão observável consistente

- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** contract-drift
- **Contract Expectation:** documento deve ser atualizado junto de mudanças observáveis e corresponder à versão usada.
- **Actual Implementation:** contrato consolidado diz 0.8.11; runtime diz 0.10.1. O contrato também exige, nas linhas 603-610, parser único com trim e estado transitório substituído, enquanto o runtime mantém parser Node + shell.
- **Evidence:** **../rb-harness/contracts/RB-RALPH-CONTRACT.md:8-10, 603-610, 1069-1071**; **VERSION:1**; **bin/rb-ralph:3610-3637**.
- **Root Cause:** release do contrato e release do runtime não são uma unidade verificável.
- **Impact:** operador/auditor não sabe quais promessas pertencem ao binário atual e pode confiar em correção ainda não efetiva.
- **Affected Modes:** documentação/distribuição inteira.
- **Existing Detection:** nenhuma preflight compara versão do consolidado com VERSION.
- **Gate Analysis:** não é defeito de uma tentativa G0-G3; altera a autoridade usada para interpretar todos os gates.
- **Required Property:** contrato consolidado, schemas, core e runtime distribuídos devem declarar uma identidade compatível e verificável.

### RALPH-AUDIT-018 — Segredos e evidência opcional não têm proveniência/redaction completa

- **Severity:** MEDIUM
- **Confidence:** CONFIRMED
- **Category:** evidence / security
- **Contract Expectation:** outputs não devem expor segredos; evidência do executor é não confiável até canonizada.
- **Actual Implementation:** **invoke_agent:1160-1164** copia submission opcional para evidence sem schema/atestado de origem do conteúdo. Logs do provider, validações bash e operational verifier são persistidos com stdout/stderr; não existe redaction geral. **evidence.cjs:14-20** exclui nomes secret-like do snapshot, mas isso não remove segredo já impresso em log.
- **Evidence:** **operational-verifier.cjs:182-210, 406-428** transmite output; adapters/provider logs são canônicos. Clean room default exclui poucos nomes. Prompt pede não imprimir, mas processo pode fazê-lo.
- **Root Cause:** proteção é por filename e cooperação, não taint/proveniência de conteúdo.
- **Impact:** segredo pode ser enviado ao modelo ou persistido; arquivo narrativo do executor pode ser confundido com prova independente.
- **Affected Modes:** CLI/custom/operational commands; APIs diretas restringem tools de leitura sensível, mas run_command YOLO pode contornar.
- **Existing Detection:** filtros por nomes de .env/credentials/keys e evidence index bounded; nenhuma redaction de valores arbitrários.
- **Gate Analysis:** G0/G2 geram logs; G1 não os inspeciona por segredo; G3 pode consumi-los; COMPLETE não depende de sanitização.
- **Required Property:** toda evidência deve ter proveniência e classe de confiança explícitas, e conteúdo persistido/enviado deve provar ausência ou redaction de segredo.

## Potential Findings Requiring More Evidence

| ID | Hipótese | Evidência atual | Evidência ainda necessária | Classificação |
| --- | --- | --- | --- | --- |
| RALPH-POT-001 | Symlink novo em path previsível de validation log/selection/audit pode fazer o próprio orchestrator sobrescrever target após snapshot. | control-plane ignora additions/symlinks; vários outputs usam redirecionamento/writeFile em nomes previsíveis. | reprodução isolada específica por plataforma, respeitando a restrição de não mutação. | UNPROVEN, potencial HIGH |
| RALPH-POT-002 | Sandbox real de versões instaladas de Codex/Claude/OpenCode pode ser mais forte ou mais fraca que os flags sugerem. | adapters e flags foram confirmados, não a implementação externa atual. | matriz com CLIs/versões reais em VM descartável, filesystem/network probes não destrutivos. | UNPROVEN |
| RALPH-POT-003 | Descendentes podem sobreviver ao process-supervisor em macOS/Windows ou por reparenting/race incomum. | supervisor e operational verifier usam process group e fallback; testes são locais. | testes de plataforma com árvore real de processos. | UNPROVEN |
| RALPH-POT-004 | Hard links podem permitir mutação de alvo fora da fronteira em caminhos não rejeitados. | evidence não registra nlink; clean room usa cp; direct write tool checa symlink, não todos os caminhos shell. | experimento específico de filesystem/OS. | UNPROVEN |
| RALPH-POT-005 | Network side effects de executor/validation/OPERATIONS podem persistir apesar de rollback local. | YOLO e comandos operacionais têm rede do usuário; Ralph só limpa processos/temporários conhecidos. | execução em rede simulada controlada e observação de efeitos externos. | UNPROVEN |

Nenhuma dessas hipóteses foi elevada a finding confirmado sem a evidência faltante.

## Missing Invariants

Faltam propriedades arquiteturais explícitas e uniformes:

1. autoridade de planejamento imutável durante toda a execução;
2. write set determinístico por task, independente do provider;
3. seal do estado entre G1/G2/G3 e COMPLETE;
4. manager incapaz de mutação por construção;
5. cache autenticado e identificado por todas as premissas;
6. equivalência semântica da validação antes/depois do executor;
7. evidência tipada por acceptance criterion, com proveniência;
8. closure positiva e monotônica de finding;
9. retry authority como interseção, nunca expansão, da task original;
10. run/resume identity que inclua estado material do produto e ambiente;
11. capability contract verificável para protected;
12. clean room que demonstre ausência de deps/build/local state;
13. cenário RBF autorizado pelo produto/contrato, não apenas plausível ao modelo;
14. conflito semântico de integração coberto por prova combinada;
15. protocolo único para executor/manager, sem parsers concorrentes;
16. redaction/proveniência para toda evidência persistida.

## Regression Test Gaps

| Invariante | Cobertura existente | Gap |
| --- | --- | --- |
| .rb/runs existente imutável | portability 1492-1521 | não testa arquivo novo/cache forjado |
| PHASES/manifest/OPERATIONS imutáveis em shared | teste de fragmento cooperativo e patch paralelo | não há executor adversarial shared |
| artifacts-dir alternativo read-only | hash permanece com mock cooperativo | não tenta escrever |
| out-of-Scope write rejeitado | cache testa fallback full | nenhuma rejeição; incidente prova sobrevivência |
| manager não escreve | apenas prompt/flags | não há manager que muta produto pós-G2 |
| red G2 vs optimistic COMPLETE | sim, portability 1387-1394 | não cobre mutação posterior/cache falso |
| test/validation integrity | nenhuma | falta alteração de assertion, package script, config, fixture, snapshot |
| cache safe reuse | validation-cache 14-58 | falta forged JSON, repo/HEAD/env/config change |
| resume | plan hash/attempts | falta source/test/context/HEAD change com plano igual |
| finding persistence | exhaustive/replay happy path | same-evidence é legacy; omissão estruturada é tratada como closure |
| finding scope | localized retry happy path | falta boundary/expected/unknown embedded ID adversarial |
| manager parser | missing matrix e alguns protocol retries | falta múltiplas decisions/status, invalid last decision, all NA, evidence livre |
| provider permissions | verifica args/env | não mede filesystem/shell/network capability real |
| direct API shell escape | tool roles inspecionados | falta argv bash -c em fixture isolada |
| worktree | baseline, overlap, conflict, cleanup | falta rename/delete matrix ampla e conflito semântico cross-file |
| G1 completeness | changes comum | falta chmod, excluded dir, oversized, symlink target |
| RBF explícito | pass/fail, .env e contract hash | falta schema drift, deps/build preexistentes, segredo alternativo |
| RBF dinâmico | prompt/caso feliz | falta cenário trivial e boundary incorreto |
| evidência opcional | cópia existe | falta forgery/proveniência/secret redaction |

A suíte verde não contradiz os findings: vários testes consolidam exatamente os limites atuais. **test-manager-review.sh:76-85** afirma o modo delivery que ignora defeitos fora dos critérios; **test-validation-cache.sh** cobre somente o modelo de impacto declarado; **test-execution-parallelism.sh:433-440** afirma closure por omissão após mudança; **test-portability-and-contract.sh:89-90** deixa a maior parte das regressões em legacy audit.

## Investigated but Rejected Hypotheses

| Hipótese | Código/experimento | Razão para rejeição |
| --- | --- | --- |
| COMPLETE textual vence diretamente agent exit/G2 red já calculado | bin/rb-ralph 3643-3648; teste portability 1387-1394 | o orchestrator converte para RETRY. O finding crítico exige mutação pós-G2 ou verde falso, não mero otimismo textual. |
| Manager de API direta pode editar projeto | api-agent-tools 214-221; 236-257; api-agent systemInstruction | role ralph-manager recebe list/read/search/git_diff, sem write/run_command. |
| Patch paralelo conflitante pode alterar parcialmente a árvore primária | integrate_worktree_changes 1715-1734; execution-parallelism 662-689 | apply --check, integração intermediária e teste deixam árvore primária intacta em conflitos exercitados. |
| Mesmo path em tasks paralelas com hunks distintos é aceito | integrate 1693-1713; teste overlap | ownership por path rejeita antes do combined patch. |
| Symlink externo entra na clean room | operational-verifier 367-383 | links absolutos e targets fora da raiz são rejeitados durante cópia. |
| cwd/file probe atravessa a clean room por .. | operational-verifier 129-138, 264-273 | resolveInside rejeita escape lexical/resolvido. |
| Command argv de OPERATIONS sofre expansão shell implícita | operational-verifier 169-194 | spawn usa shell=false; usar explicitamente um shell continua sendo autoridade do contrato, não injeção implícita. |
| Changed path fora de todos os Scopes permite cache incremental parcial | validation-cache 85-89; test-validation-cache 48-56 | o helper cai para full no delta atual. O finding de stale cache trata mudanças fora desse delta/identidade. |
| Human validation é entregue silenciosamente ao modelo | preflight + portability 1435-1455 | human pausa antes do provider no caso testado. Manual continua dependente do manager. |
| Alterar PHASES preserva o mesmo run ID | run ID 2885-2890; contract/manifest | hash diferente cria outro run. O finding de resume trata plano inalterado com estado externo alterado. |
| Modificar arquivo existente de .rb/runs passa despercebido | control-plane + portability 1492-1521 | é detectado depois do provider e tentativa é rejeitada. A falha confirmada é additions/efeito já ocorrido. |
| Evidence snapshot segue symlink e lê segredo externo | evidence.cjs 42-49 | registra apenas texto do target, sem dereference. Isso cria gap de mudança, não exfiltração pelo snapshot. |

## Systemic Root Causes

1. **Policy-as-prompt:** imutabilidade, write scope, disciplina do gerente, não enfraquecer testes e suficiência do RBF são tratados como comportamento esperado do modelo.
2. **Confusão entre observabilidade e enforcement:** G1 listar um path é usado como substituto de rejeitar uma mudança não autorizada.
3. **Objeto auditado não selado:** executor, validação e manager operam na mesma árvore em momentos diferentes sem identidade final comum.
4. **Exit code como semântica:** G2 prova sucesso de processo e infere, sem base mecânica, que o processo ainda representa o critério.
5. **Identidade incompleta:** cache, finding e resume usam hashes de comando/plano/delta em vez das premissas completas.
6. **Manager como policy engine não confinado:** linguagem natural define PASS, NA, finding, boundary e retry authority.
7. **Capabilities delegadas:** protected é traduzido por cada adapter e pode ser override/ignorado sem attestation.
8. **Múltiplos validadores/parsers:** contrato formal, operational-verifier, manager-audit e shell possuem semânticas divergentes.
9. **Otimização antes de segurança:** exclusions, cache incremental, contexto bounded e closure por lote reduzem custo, mas não carregam invariantes suficientes.
10. **Testes de caminho feliz:** a suíte é extensa em portabilidade/orquestração, porém pequena em adversarial invariant coverage.

## Risk Prioritization

| Prioridade | Findings | Motivo |
| --- | --- | --- |
| P0 — aceitação não confiável | 001, 002 | permitem COMPLETE sobre estado não validado ou validação nunca executada |
| P1 — autoridade e prova | 003, 004, 005, 006, 007, 008, 009, 010 | permitem substituir requisitos, expandir scope, greenwash e reutilizar/fechar prova obsoleta |
| P1 — isolamento/permissão/RBF | 011, 012, 013, 014 | tornam garantias dependentes do provider, invisibilizam mudanças e enfraquecem aceitação final |
| P2 — consistência/defesa | 015, 016, 017, 018 | aumentam risco em configurações/modos específicos e reduzem auditabilidade/confidencialidade |

Relações causais:

- 003 + 004 + 008 formam uma única família de autoridade não confinada;
- 005 + 006 + 012 formam a família de prova verde sem identidade;
- 001 + 011 formam a família de auditor com poder de desenvolvimento;
- 007 + 009 formam a família de evidência persistida sem invalidation/closure suficientes;
- 013 + 014 formam a família de aceitação operacional semanticamente fraca.

## Required Properties Before Remediation

Esta seção define propriedades, não soluções ou patches:

1. COMPLETE refere-se a um estado imutavelmente identificado e ainda presente.
2. Executor e manager têm capacidades distintas aplicadas pelo runtime, não apenas pelo prompt.
3. A task não consegue escrever fora de sua autoridade declarada sem uma expansão explícita registrada.
4. Nenhum artefato de contrato, controle ou evidência canônica pode ser criado/substituído por provider.
5. G1 é completo para toda premissa de G2 ou declara o estado UNPROVEN.
6. G2 autentica tanto o resultado quanto a definição/inputs do mecanismo de validação.
7. Cache reuse demonstra equivalência material do estado, ambiente e toolchain.
8. Manager output possui uma única interpretação e evidência verificável por row.
9. Finding não pode ampliar requisitos e não fecha sem prova positiva específica.
10. Resume invalida qualquer prova afetada por source, HEAD, tests, Context, dependencies, config, environment ou operations.
11. Protected possui uma matriz de capacidades uniforme e verificável; ausência falha fechada.
12. Integração paralela prova invariantes do estado combinado, além de conflito textual.
13. RBF exercita entrypoint/capacidade autorizados e registra observáveis duráveis adequados ao produto.
14. Clean room demonstra que dependências, builds, estado e segredos não declarados não participaram.
15. Logs/evidence carregam proveniência e proteção contra segredo.
16. Cada invariante acima possui teste negativo que falha quando a proteção é removida.

Nenhuma escolha de mecanismo de implementação é proposta nesta auditoria.

## Audit Limitations

- Não foram chamados providers externos reais nem usadas credenciais; capacidades nativas exatas de versões instaladas permanecem UNPROVEN onde indicado.
- Não foram realizados testes destrutivos, commits, branches, pushes, rede externa ou mutações na árvore auditada.
- A reprodução de RALPH-AUDIT-001 ocorreu em projeto temporário independente e descartável; o diretório foi apagado após coleta do resultado.
- Experimentos de parser/cache/verifier usaram stdin/process substitution e não persistiram artefatos no repositório.
- Hard links, escapes por processos em todas as plataformas e semântica de sandboxes externas exigem ambientes dedicados adicionais.
- O contrato consolidado está versionado como 0.8.11 e o runtime como 0.10.1; quando divergiram, este relatório descreveu o código efetivamente executável e registrou o drift.
- “Complete” aqui significa cobertura integral dos componentes e fluxos identificados, não prova matemática sobre providers ou sistemas operacionais externos não executados.

## Repository Integrity Check

Estado inicial:

- HEAD: de8911f024769e3e3ffd08c131bd87c80cd25390
- git status --short: vazio
- runtime: 0.10.1

Verificação final esperada e posteriormente conferida:

- nenhum arquivo tracked modificado;
- nenhum arquivo staged;
- nenhum artefato .rb criado/modificado;
- único untracked/persistente da auditoria: RB-RALPH-AUDIT-REPORT.md.

Comandos de integridade utilizados: git status --short --untracked-files=all, git diff --quiet, git diff --cached --quiet e git ls-files --others --exclude-standard.

Resultado: a única diferença persistente da auditoria é este relatório. Nenhuma correção, patch de implementação, formatter, commit, branch ou evidência Ralph foi criada ou alterada.
