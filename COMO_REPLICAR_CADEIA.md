# Como replicar a aba Cadeia Produtiva para outro setor

A aba mostra, com dados do IBGE, de onde vêm os insumos de um setor e para
quem ele vende. Hoje o setor em destaque é a fundição (peças fundidas). Para
trocar de setor **não precisa mexer em código**: tudo que é específico do setor
está em `cadeia_config.json`.

Tempo estimado: 30 minutos, a maior parte escolhendo os botões com base nos
dados.

## Antes de começar

- Python com os pacotes do projeto (ver `PASSAGEM.md`, seção "Do que a pessoa
  precisa no computador").
- As tabelas do IBGE em `Setor Siderúrgico/1_Dados_Manuais_XLS/`:
  - `TRU_Nivel_68_2010_2021/` (Tabelas de Recursos e Usos, `68_tab1_*.xls` e
    `68_tab2_*.xls`)
  - `MIP_2015_Nivel_67.xls` (Matriz Insumo-Produto)

  Os endereços para baixar estão no topo de `extrair_cadeia.py`.

Os comandos abaixo são para o PowerShell, dentro da pasta do projeto.

## Passo 1. Achar o código do produto

O IBGE não trabalha com CNAE nas Contas Nacionais. Ele usa 68 **atividades**
(4 dígitos) e 128 **produtos** (5 dígitos). Liste os códigos:

```powershell
.venv\Scripts\python extrair_cadeia.py --listar
```

Escolha o **produto** do setor. Exemplos: `24922` peças fundidas, `22002`
artigos de plástico, `29921` peças e acessórios para veículos.

Para saber qual CNAE cai em qual atividade, use a tabela oficial do IBGE
`Tradutor_Atividade_CNAE.xls`, em
ftp.ibge.gov.br → Contas_Nacionais → Sistema_de_Contas_Nacionais → Tradutores.

> Atenção: vários CNAEs podem estar dentro de uma mesma atividade. A fundição
> (CNAE 24.51 e 24.52), por exemplo, fica dentro da atividade 2492, junto com a
> metalurgia de não ferrosos. Por isso a aba parte do **produto**, que é mais
> específico.

## Passo 2. Ver quem produz e quem compra

```powershell
.venv\Scripts\python extrair_cadeia.py --sugerir 22002
```

O comando mostra:

- **Quem produz:** a primeira linha é a `atividade` que vai na configuração.
- **Quem compra direto**, do maior para o menor, com o percentual acumulado
  e em quantos anos da série cada comprador aparece. Use isso para escolher
  os botões de "clientes diretos" e os "principais clientes".
- **Importação:** quanto da oferta vem de fora.

> **Escolha os botões pelos dados, não pela intuição.** Na fundição, a ideia
> inicial era pôr "montadoras" como cliente, mas o `--sugerir` mostra que
> montadora não compra peça fundida direto em nenhum ano: ela recebe a peça
> dentro da autopeça. Quem não aparece na lista de compradores não é cliente
> direto. Se quiser mostrar esse setor, ponha num grupo separado, como o "via
> autopeças" da fundição.

## Passo 3. Preencher `cadeia_config.json`

Faça uma cópia do arquivo atual antes (por exemplo,
`cadeia_config_fundicao.json`) para poder voltar. Depois troque os campos:

| Campo | O que é | Exemplo (plástico) |
|---|---|---|
| `produto` | código de 5 dígitos do passo 1 | `"22002"` |
| `atividade` | primeira linha de "quem produz" do passo 2 | `"2200"` |
| `nome` | nome curto do setor (aparece no centro do diagrama) | `"Plástico"` |
| `nome_produto` | o produto no meio da frase, em minúsculas | `"artigos de plástico"` |
| `descricao_produto` | subtítulo do diagrama | `"Artigos de plástico"` |
| `titulo` | título da aba | `"Para onde vai o plástico"` |
| `nota_insumos` | explica de onde vem o lado "de onde vem" (ajuste o código e o nome da atividade) | ver o arquivo |
| `principais_clientes` | códigos somados na frase do topo e o texto que os descreve | `["4180", "1093", "1091", "1100"]` e `"a construção e a indústria de alimentos e bebidas"` |
| `empregos_rais` | setores do painel com RAIS para o link "Empregos formais"; `[]` se não houver | `[]` |
| `elos` | botões acima do diagrama, na ordem da cadeia | ver abaixo |
| `grupos_cor` | compradores com cor própria (os outros ficam cinza), usando `series-1` a `series-8` | ver o arquivo |

**Botões (`elos`).** Cada grupo é uma etapa da cadeia, e as setas aparecem
entre os grupos. Cada botão tem um `label` (o texto) e um `centro` (o código
da atividade que ele abre). Use `"produto"` no botão do próprio setor; ele é
obrigatório. `rotulo` é opcional e aparece antes do grupo (ex.: "clientes
diretos").

```json
"elos": [
  { "itens": [{ "label": "Petróleo e gás", "centro": "0680" }] },
  { "itens": [{ "label": "Refino", "centro": "1991" }, { "label": "Químicos e resinas", "centro": "2091" }] },
  { "itens": [{ "label": "Plástico", "centro": "produto" }] },
  { "rotulo": "clientes diretos", "itens": [
    { "label": "Construção", "centro": "4180" },
    { "label": "Alimentos", "centro": "1093" }
  ] }
]
```

Os campos que começam com `_` são só comentários e podem ficar como estão.

## Passo 4. Gerar os dados e conferir

```powershell
.venv\Scripts\python extrair_cadeia.py     # gera os CSVs Cadeia_* para o produto da config
.venv\Scripts\python -m pytest             # confere a config e os dados
.venv\Scripts\python build_data.py         # gera o data/data.json
pwsh -File serve.ps1                       # abre em http://localhost:8791
```

Se a configuração citar um código de atividade que não existe, o
`build_data.py` para e mostra quais são.

Na aba, confira:

- se a frase do topo faz sentido;
- se cada botão abre o setor certo;
- se o "Para onde vai" bate com o `--sugerir`.

## Passo 5. Publicar

Só depois de conferir, faça commit da config e dos CSVs e dê `push` (ver
`PASSAGEM.md`). O site se republica sozinho.

## Duas formas de usar

- **Trocar o setor deste painel:** siga os passos acima neste projeto. A aba
  passa a mostrar o novo setor, e o resto do painel continua sendo de fundição.
- **Fazer um painel para outro setor:** copie o projeto inteiro para outra
  pasta, ou crie outro repositório no GitHub, e siga os passos lá. É o caminho
  para ter, por exemplo, um painel de plástico e outro de fundição no ar ao
  mesmo tempo.

## Limitações que valem para qualquer setor

- **Defasagem:** os dados são de 2021, porque o IBGE publica a TRU com uns 3
  anos de atraso.
- **Insumos estimados:** o IBGE não separa os insumos por produto. O lado
  "de onde vem" usa a estrutura de custos da atividade inteira, proporcional
  à produção do produto. Quanto mais a atividade misturar coisas diferentes,
  mais aproximado fica.
- **Não é uma Matriz Insumo-Produto completa.** Só o multiplicador e a parcela
  importada dos insumos vêm da MIP oficial, que é de 2015.
