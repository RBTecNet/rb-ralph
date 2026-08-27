# RB Ralph — Relatório de Remediação do Batch 1

Versão auditada e alterada: RB Ralph `0.10.1` (`de8911f024769e3e3ffd08c131bd87c80cd25390`).

## Changes Implemented

- `bin/rb-ralph`
  - passou a emitir recibos externos ao projeto para cada arquivo canônico criado pelo orquestrador durante uma chamada de provider;
  - rejeita adições sem recibo, alterações ou exclusões em estado canônico e sela o projeto/run como comprometido;
  - captura um delta completo por task e rejeita paths protegidos ou fora do `Scope` antes de G2/G3;
  - valida patches de worktree contra o `Scope` da task antes da integração e verifica que providers isolados não alteraram diretamente a árvore primária;
  - sela o estado completo do produto antes de cada chamada G3 e compara o estado após o gerente;
  - invoca todo gerente com `RB_RALPH_PERMISSION_MODE=protected` e `RB_RALPH_YOLO=0`;
  - impede resume após violação de autoridade até restauração explícita pelo operador.
- `lib/control-plane.cjs`
  - snapshots passaram a representar arquivos, symlinks e tipos especiais;
  - o diff passou a listar adições;
  - `receipt`, `receipt-tree` e `verify` distinguem estado criado pelo orquestrador de estado introduzido pelo provider.
- `lib/evidence.cjs`
  - adicionados `seal-snapshot` e `seal-diff`, sem exclusões de source/build/dependências, sem limite de quantidade/tamanho e com tipo/modo do path;
  - o selo é usado somente nas fronteiras de autoridade deste lote; o índice normal de evidência permanece limitado como antes.
- `lib/validation-cache.cjs`
  - o matcher já usado para impacto incremental agora também produz `rb-ralph-write-authority/v1`;
  - `authorize`, `authorize-paths` e `protect` aplicam precedência de artefato protegido sobre `Scope` e falham quando o escopo não é mecanicamente delimitável.
- `lib/manager-audit.cjs`
  - IDs desconhecidos em findings invalidam o audit;
  - a seleção de retry deriva apenas das linhas `FAIL`/`UNPROVEN` validadas da matriz;
  - `boundary`, `expected` e demais textos livres deixaram de selecionar tasks ou dependências.
- `adapters/codex.sh`, `adapters/claude.sh`, `adapters/opencode.sh`
  - overrides que dariam escrita ao gerente falham explicitamente: Codex exige `read-only`, Claude exige `plan` e OpenCode não aceita permissão customizada para G3.
- `README.md` e `README.pt-BR.md`
  - documentam o gerente sempre protegido, `Scope` como fronteira de escrita em `execution-unit task` e findings como diagnóstico sem autoridade própria.

Não foi alterada a semântica geral de validação, identidade de cache/resume, fechamento de findings, RBF ou conflitos semânticos paralelos dos lotes posteriores.

## Invariants Established

| Invariante | Enforcement de runtime | Regressão | Resultado observado |
|---|---|---|---|
| `INV-AUTH-001` | selo completo em `evidence.cjs`; comparação imediatamente após `invoke_manager`; gerente sempre `protected/0`; adapters inseguros falham; mutação gera `MANAGER_STATE_VIOLATION` e marcadores de comprometimento | `TEST-AUTH-001` | gerente alterou o produto após G2; Ralph saiu diferente de zero, não gravou `COMPLETE` e recusou o resume; Codex, Claude e OpenCode rejeitaram overrides de escrita |
| `INV-AUTH-002` | snapshot + recibos externos + `control-plane verify`; arquivos adicionados sem recibo são unowned; run comprometido não pode ser retomado | `TEST-AUTH-002` | executor criou o cache previsível `P01-validation-cache.json`; Ralph encerrou antes de G2, registrou `CONTROL_PLANE_VIOLATION` e não confiou no arquivo |
| `INV-AUTH-003` | selo completo da árvore; `protect` rejeita `.rb/**` e todo o artifacts-dir selecionado, inclusive alternativo; violação bloqueia G2/G3 e resumes | `TEST-AUTH-003` | executor alterou o `PHASES.md` selecionado em shared/task; execução falhou com `WRITE_AUTHORITY_VIOLATION` e sem `COMPLETE` |
| `INV-AUTH-004` | delta completo individual por task; matcher de `Scope` compartilhado com o cache; autorização individual de patch em worktree; verificação da árvore primária antes da integração | `TEST-AUTH-004` | delta com um arquivo autorizado e outro não autorizado foi rejeitado antes de G2/G3 e não chegou a `COMPLETE` |
| `INV-AUTH-005` | parser rejeita IDs desconhecidos; retry usa apenas matriz validada; prompt classifica findings como diagnóstico; `Scope` continua sendo o gate mecânico no retry | `TEST-AUTH-005` | finding válido pediu arquivo fora do `Scope`; retry permaneceu em `T001`, a prosa foi preservada como diagnóstico e a escrita solicitada foi rejeitada |

## Findings Status

| Finding | Status | Evidência de encerramento |
|---|---|---|
| `RALPH-AUDIT-001` | **RESOLVED** | `TEST-AUTH-001` prova que mutação pós-G2 não pode receber `COMPLETE` nem virar baseline por resume |
| `RALPH-AUDIT-002` | **RESOLVED** | `TEST-AUTH-002` prova que arquivo novo de cache/evidência sem propriedade do orquestrador não é canônico |
| `RALPH-AUDIT-003` | **RESOLVED** | `TEST-AUTH-003` prova rejeição determinística de mutação do plano em shared antes de G2/G3 |
| `RALPH-AUDIT-004` | **RESOLVED** | `TEST-AUTH-004` prova `Scope` como write boundary para `execution-unit task` |
| `RALPH-AUDIT-008` | **RESOLVED** | `TEST-AUTH-005` e a regressão de ID desconhecido provam que findings não criam tasks/paths autorizados |

## Tests

Nova suíte: `tests/test-authority-enforcement.sh`, cobrindo `TEST-AUTH-001` a `TEST-AUTH-005`, inclusive resume comprometido e overrides inseguros dos três adapters CLI.

Suíte completa executada após a última alteração, toda verde:

- `tests/test-agent-context.sh`;
- `tests/test-context-efficiency.sh`;
- `tests/test-dashboard-focus.sh`;
- `tests/test-manager-review.sh`;
- `tests/test-validation-cache.sh` — `1..6`;
- `tests/test-authority-enforcement.sh`;
- `tests/test-execution-parallelism.sh` — `1..99`;
- `tests/test-portability-and-contract.sh` — `1..247`.

Também passaram `bash -n`, `node --check` nos helpers alterados e `git diff --check`.

Expectativas antigas alteradas por representarem os defeitos confirmados:

- adulteração do control-plane agora encerra antes de chamar o gerente, em vez de seguir para um retry decidido por G3;
- `boundary` de finding não reinsere dependência na seleção de retry;
- mocks task-level foram movidos para os `Scope` declarados; cenários de colisão paralela receberam um path comum explicitamente declarado para continuar testando a colisão legítima.

Nenhum teste foi removido, pulado ou enfraquecido para obter verde.

## Compatibility Notes

- `--yolo` continua controlando o executor. O gerente agora é sempre protegido, inclusive numa execução YOLO.
- Codex manager diferente de `read-only`, Claude manager diferente de `plan` e permissão customizada de OpenCode manager são erros observáveis e fail-closed.
- Adapters customizados recebem `protected/0`; caso ignorem o sinal, a comparação pós-G3 rejeita qualquer delta persistente.
- `execution-unit task` agora rejeita escrita fora do `Scope`. `execution-unit phase` mantém a compatibilidade de escopo amplo, mas não pode alterar artefatos de autoridade.
- Em worktree, patch fora do `Scope` não é aplicado à árvore primária. Em shared, a violação é detectada depois da chamada, encerra o processo e bloqueia novos runs até recuperação explícita.
- O artifacts-dir selecionado, inclusive alternativo, sempre tem precedência como área protegida, mesmo se um `Scope` amplo aparentar incluí-lo.

## Remaining Risks

- Em shared ou adapter customizado sem sandbox, o provider ainda pode causar a mutação física antes da detecção. Ralph não tenta rollback automático: falha, preserva a evidência e grava `AUTHORITY-COMPROMISED` no run e no projeto. O operador deve restaurar o estado e remover conscientemente os marcadores. A mutação não pode ser aceita nem reutilizada silenciosamente por Ralph.
- A proteção do manager customizado é fail-after-call; built-ins e direct API possuem restrição preventiva, enquanto custom depende do selo como backstop.
- Este lote não autentica semanticamente testes/validações, não amplia a identidade do cache/resume e não redefine o fechamento geral de findings. Esses itens permanecem nos batches correspondentes e não foram usados para ampliar esta remediação.
