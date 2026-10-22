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
| `extrair_ibge.R` | IBGE/SIDRA e Banco Central (PIA, PIM-PF, IPCA, câmbio, IPP) | nenhuma | mensal (PIM, IPCA); anual (PIA) |
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

## Cesta de produtos (NCM/HS)

Não existe correspondência automática entre atividade (CNAE) e produto (NCM).
As cestas atuais estão em `config_setor.R` e descritas no `config_painel.json`
(campo `cesta_ncm`). Qualquer mudança precisa ser aprovada pelo dono do projeto
antes da coleta.
