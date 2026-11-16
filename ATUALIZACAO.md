# Atualização periódica dos dados

Este painel não busca dados ao vivo: os números vêm de CSVs processados
localmente e publicados a cada `git push`. Manter o painel atualizado depende
de alguém repetir, periodicamente, o processo abaixo.

## Como o site é publicado

1. Os scripts de coleta (fora deste repositório) atualizam os CSVs em
   `Setor Borracha/3_Dados_Tratados_CSV/`.
2. Copie os CSVs para `3_Dados_Tratados_CSV/` deste repositório.
3. Rode `python build_data.py` e `python build_downloads.py` (ou deixe o CI
   fazer isso) e confira com `pytest`.
4. Dê `git push` para a branch `main`. O GitHub Actions
   (`.github/workflows/build.yml`) reconstrói e republica o site no GitHub
   Pages automaticamente.

## Scripts de coleta

Ficam em `Setor Borracha/2_Scripts/`, **fora deste repositório** (a pasta tem
o `.Renviron` com as credenciais e ~2,5 GB de arquivos brutos). Rodam com R
(`Rscript`) a partir da pasta `Setor Borracha/`; cada um baixa só o que falta.
Tudo o que muda de um setor para outro está em `2_Scripts/config_setor.R`.

| Script | Fonte | Credencial | Periodicidade sugerida |
|---|---|---|---|
| `extrair_ibge.R` | IBGE/SIDRA e Banco Central (PIA-Empresa do grupo e por classe, PIM-PF, IPCA, câmbio, IPP) | nenhuma | mensal (PIM, IPCA); anual (PIA) |
| `obter_pia_produto.R` | IBGE, PIA-Produto (valor da produção por produto): API do SIDRA de 2014 em diante (tabelas 7752 e 10476); arquivos do servidor ftp.ibge.gov.br para 2007–2013 | nenhuma | anual |
| `obter_comex.R` | API do Comex Stat | nenhuma | mensal |
| `obter_comtrade.R` | API do UN Comtrade | `COMTRADE_API_KEY` | semestral |
| `obter_bndes.R` | CSVs do portal de dados abertos do BNDES | nenhuma | trimestral |
| `obter_rais.R` | BigQuery (Base dos Dados) + FTP do PDET | `GOOGLE_CLOUD_PROJECT` | anual |
| `obter_caged_antigo.R` | BigQuery | `GOOGLE_CLOUD_PROJECT` | não muda (até 2019) |
| `obter_novo_caged.R` | BigQuery | `GOOGLE_CLOUD_PROJECT` | mensal |
| `obter_caged_ftp.R` | FTP do PDET (meses que o BigQuery ainda não tem) | nenhuma | mensal |
| `tratar_caged.R` | junta os três CAGED | nenhuma | depois dos três acima |

Ordem do CAGED: antigo → novo → ftp → tratar. Energia Industrial é comum a
todos os painéis setoriais e não é coletada por estes scripts.

**Credenciais:** ficam apenas em `Setor Borracha/.Renviron`. Nunca copie
chaves para código, arquivos versionados, mensagens de commit ou issues.

## Se os CSVs vierem como planilha (.xlsx)

Baixar a pasta pelo Google Drive pode converter os CSVs em planilhas. O script
`Setor Borracha/2_Scripts/converter_xlsx_para_csv.py` desfaz a conversão e
confere valor a valor. Os arquivos de energia **não** podem ser recuperados
assim (a conversão do Drive corrompe o ponto decimal): use os CSVs originais
de outro painel.

## Indicadores de desempenho (PIA-Empresa por classe)

`extrair_ibge.R` (função `obter_pia_indicadores`) grava
`PIA_Empresa_Indicadores_<Rotulo>.csv`: PIA-Empresa por classe CNAE, 2007–2023,
das tabelas SIDRA 7241 a 7245 (classificação 12762), para as classes do setor
(`cnae_sidra`), o grupo (`cnae_grupo_sidra`) e a indústria de transformação
(`cnae_comparacao_sidra`, código 116910). `build_data.py` calcula a tabela
"Pontos de destaque" do diagnóstico setorial da FIESP (seção Financeiro), com a
metodologia da planilha DRE: R$ pelo IPCA de dezembro, lucro bruto = valor
adicionado − gastos de pessoal, margem bruta = lucro bruto / receita líquida,
investimento líquido = aquisições + melhorias − baixas. 2024 é nova série da
PIA e fica fora da comparação.

## PIA-Produto e mercado doméstico

`obter_pia_produto.R` grava `PIA_Produto_<Rotulo>.csv` com o valor da produção
dos produtos da cesta PRODLIST (`prodlist_cestas` em `config_setor.R`):

- **2014 em diante:** API do SIDRA, tabelas 7752 (2014–2023) e 10476 (2024+),
  variável 215 (valor da produção), classificação 1264 (produtos Prodlist),
  configurados em `pia_produto_sidra` no `config_setor.R`. É a mesma série do
  diagnóstico setorial da FIESP (bate com ela até 0,2%).
- **2007 a 2013:** Tabela 1 dos arquivos anuais do servidor do IBGE (a tabela
  5806 do SIDRA usa outra classificação). Diferença para a FIESP de até ~6%
  em 2007–2011, por revisões das listas de produtos antigas.

A PIA-Produto sai com cerca de dois anos de defasagem: o aviso de "sem dados"
para o ano mais recente é esperado até o IBGE publicar.

`cesta_componentes.csv` (neste repositório) liga cada NCM e cada PRODLIST ao
mesmo produto ("componente" do algoritmo da FIESP), para a tabela por produto
da seção Mercado doméstico. Ao mudar a cesta de NCM ou de PRODLIST, atualize
os três lugares juntos: `ncm_cestas`, `prodlist_cestas` e este CSV.

## Cesta de produtos (NCM/HS)

Não existe correspondência automática entre atividade (CNAE) e produto (NCM).
As cestas atuais estão em `config_setor.R` e descritas no `config_painel.json`
(campo `cesta_ncm`). Qualquer mudança precisa ser aprovada pelo dono do projeto
antes da coleta.
