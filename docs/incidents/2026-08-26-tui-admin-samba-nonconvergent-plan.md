# Incidente: `tui_admin_samba` entrou em retries por plano Go não convergente

- Data da análise: 2026-08-26
- Projeto afetado: `/home/bruno/Documentos/Projetos/testes/tui_admin_samba`
- Run: `.rb/runs/init-phases-266cf96f2a49`
- Fase: P01, especialmente T001
- Severidade: alta — quatro tentativas consumidas antes de uma correção fora do escopo declarado
- Proprietário principal: time do Harness
- Agravantes: executor insistiu em `COMPLETE`; Ralph repetiu toda a fase e não classificou conflito de plano/escopo

## Conclusão executiva

A primeira tentativa falhou por ambiente: o comando `go` não estava disponível. As tentativas 2, 3 e 4 falharam principalmente por uma contradição no plano gerado pelo Harness.

T001 exigia simultaneamente:

- alterar apenas `go.mod` e `go.sum`;
- manter Bubble Tea e Lip Gloss como dependências diretas;
- executar `go mod tidy`.

Porém, o primeiro uso real dessas bibliotecas só estava planejado para T038, na P08. Em Go, `go mod tidy` remove dependências não importadas. Portanto, não existia estado estável que satisfizesse T001 dentro do seu próprio escopo.

Na tentativa 5, a execução convergiu ao introduzir uso real das bibliotecas em `internal/app/app.go`, fora do escopo de T001 e antecipando parte da TUI planejada para `internal/tui` em P08. Isso encerrou o sintoma, mas não corrige o defeito de planejamento.

## Responsabilidade direta

- Tentativa 1: ambiente de execução, pois `go` estava ausente.
- Tentativas 2–4: Harness, por gerar contrato internamente incompatível com a semântica de `go mod tidy`.
- Custo multiplicado: Ralph, por não detectar conflito de escopo e repetir T001–T005 em cada nova tentativa.
- Comportamento incorreto secundário: executor, por declarar `COMPLETE` mesmo reconhecendo que a próxima validação removeria o resultado.

## Evidências

### 1. Linha do tempo das decisões

Em `.rb/runs/init-phases-266cf96f2a49/events.tsv`:

```text
linha 2 — tentativa 1: BLOCKED, Go indisponível
linha 3 — tentativa 2: RETRY, dependências diretas ausentes
linha 4 — tentativa 3: RETRY, mesmo achado
linha 5 — tentativa 4: RETRY, tidy remove as dependências e é necessário uso/importação real
linha 6 — tentativa 5: COMPLETE
```

O gerente identificou corretamente o mesmo requisito não satisfeito nas tentativas 2–4.

### 2. Contradição dentro de T001

Em `.rb/runs/init-phases-266cf96f2a49/phases/P01.txt:20-34`:

```text
Scope: go.mod, go.sum
Change: adicionar Bubble Tea e Lip Gloss como dependências diretas
AC-T001-02: ambas devem permanecer diretas no go.mod
Validation: go mod tidy; go list ./...
```

O escopo não permite criar um arquivo Go que importe as bibliotecas. Sem importação, `go mod tidy` remove os requisitos diretos.

### 3. O uso real foi adiado até P08

Em `.rb/init/PHASES.md:733-748`, T038 é a primeira tarefa que pede o modelo Bubble Tea:

```text
T038 — Definir o modelo e a navegação principal da TUI
Scope: internal/tui/model.go, internal/tui/navigation.go, internal/tui/model_test.go
Change: implementar o modelo Bubble Tea...
```

Logo, o plano separou a declaração das dependências e o primeiro import por sete fases, embora a validação da primeira fase elimine as dependências não utilizadas.

### 4. O próprio executor reconheceu que o resultado não era estável

Em `logs/P01-T001-attempt-2-agent.log`:

```text
linha 14: “go mod tidy removeu Bubble Tea e Lip Gloss porque o código atual não os importa”
linha 21: “uma execução futura de go mod tidy voltará a podá-las”
linha 30/53: RB_RALPH_EXECUTOR_STATUS: COMPLETE
```

O executor restaurou os requisitos depois do `tidy` com `go mod download`, mas o validador canônico executou `go mod tidy` novamente e removeu o resultado. Declarar `COMPLETE` nesse estado foi incorreto, embora o contrato impossível tenha origem no plano.

### 5. A tentativa 5 resolveu fora do escopo e antecipou arquitetura futura

O estado atual de `internal/app/app.go:14-38` importa Bubble Tea e Lip Gloss, cria `tuiTitleStyle` e define `TUIModel`. Isso está fora do escopo de T001 (`go.mod`, `go.sum`) e diverge da fronteira planejada para T038 (`internal/tui/...`).

Esse uso faz `go mod tidy` preservar as dependências e explica o `COMPLETE` da tentativa 5, mas cria dívida de arquitetura e evidencia que a tarefa original não podia ser resolvida dentro do escopo.

### 6. O Ralph repetiu tarefas sem relação com o achado aberto

Existem logs da tentativa 5 para todas as tarefas de P01:

```text
P01-T001-attempt-5-agent.log
P01-T002-attempt-5-agent.log
P01-T003-attempt-5-agent.log
P01-T004-attempt-5-agent.log
P01-T005-attempt-5-agent.log
```

O achado do gerente citava somente T001/AC-T001-02. Reexecutar T002–T005 aumentou chamadas, tokens, tempo e risco de alterações colaterais sem necessidade comprovada.

### 7. A validação de build deixou artefato no projeto

Os logs executam `GOOS=linux GOARCH=amd64 go build ./cmd/samba-admin`, que produz `samba-admin` na raiz. A evidência posterior identifica esse arquivo como ELF. Uma validação não deveria poluir o workspace; deve usar `-o` apontando para área temporária.

## Causa raiz

O gerador/validador do Harness não aplicou uma regra de estabilidade específica da stack: em módulos Go, declarar uma dependência e rodar `go mod tidy` só é estável quando há um import legítimo no grafo de pacotes. Os critérios foram avaliados individualmente, mas não quanto à possibilidade de coexistirem depois da validação canônica.

O Ralph, por sua vez, não possui um escape adequado para “a correção pedida exige caminho fora do escopo”. Ele tratou a situação como retry comum até que um agente expandiu o escopo por conta própria.

## Correções requeridas — Harness

1. Adicionar validação de coerência para planos Go: dependência direta + `go mod tidy` exige uso real na mesma tarefa/fase e dentro do escopo.
2. Quando o primeiro uso estiver em fase posterior, mover a declaração da dependência para essa fase; alternativamente, incluir um import legítimo e a fronteira correspondente no escopo atual.
3. Validar critérios no estado posterior a todos os comandos canônicos, não em um estado restaurado depois deles.
4. Verificar automaticamente se a remediação previsível de cada critério cabe nos caminhos declarados em `Scope`.
5. Evitar tarefas de “instalação antecipada” de dependências que a ferramenta oficial da stack remove por falta de uso.

## Correções requeridas — Ralph

1. Detectar repetição do mesmo achado quando a correção necessária está fora do escopo e emitir `PLAN_CONFLICT`/`BLOCKED`, em vez de retry ilimitado.
2. Validar os caminhos alterados por tarefa. Alteração fora de escopo deve ser rejeitada ou encaminhada para decisão explícita, não usada silenciosamente para fechar a fase.
3. Reexecutar somente as tarefas relacionadas aos critérios abertos, mais dependências comprovadamente necessárias; não repetir toda a fase por padrão.
4. Rejeitar `COMPLETE` do executor quando ele próprio informa que a validação canônica subsequente desfará o resultado.
5. Executar build de validação com saída temporária, por exemplo `go build -o "$tmp/samba-admin" ./cmd/samba-admin`.

## Testes de regressão obrigatórios

- Fixture Go com `go.mod/go.sum` no escopo, dependência direta obrigatória, `go mod tidy` e nenhum import deve ser rejeitada pelo Harness antes da execução.
- Variante válida deve colocar declaração e primeiro uso na mesma fase e permanecer idêntica após dois `go mod tidy` consecutivos.
- Ralph deve transformar “mesmo achado + correção fora do escopo” em conflito de plano acionável.
- Um finding restrito a T001 não deve invocar T002–T005 novamente sem dependência explícita.
- Build de validação não deve criar binário na raiz do projeto.

## Critério de encerramento

O incidente pode ser encerrado quando o Harness não gerar mais a combinação impossível, o Ralph impedir fechamento por alteração fora de escopo e a fixture convergir em uma única tentativa válida após a disponibilidade do toolchain.
