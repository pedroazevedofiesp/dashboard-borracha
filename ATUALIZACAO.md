# Atualização periódica dos dados

Este painel não busca dados ao vivo: os números vêm de arquivos brutos
processados localmente e publicados a cada `git push`. Manter o painel
"vivo" depois de publicado no site do SIFESP depende de alguém repetir,
periodicamente, o processo abaixo.

## Como o site é publicado

1. Alguém atualiza os CSVs brutos em `3_Dados_Tratados_CSV/`.
2. Roda `python build_data.py` (gera `data/data.json`) e
   `python build_downloads.py` (gera as planilhas de download).
3. Dá `git push` para o branch principal.
4. O GitHub Actions (`.github/workflows/build.yml`) reconstrói e republica
   o site automaticamente no GitHub Pages a partir daí — **essa etapa já é
   automática**, não precisa de ação manual.

O que falta automatizar é só a etapa 1: buscar dado novo em cada fonte.

## Fontes, por tipo

| Fonte | Como é obtida hoje | Periodicidade recomendada |
|---|---|---|
| IBGE (produção física, financeiro/PIA) | Automática via API (script) | Mensal / anual, conforme a fonte |
| Banco Central (IPCA, câmbio) | Automática via API (script) | Mensal |
| BNDES | Automática via API (script) | Trimestral |
| UN Comtrade (comércio mundial) | Automática via API (script) | Trimestral |
| CAGED (2020 em diante) | Automática via consulta a banco de dados (script) | Mensal |
| Comex Stat (exportação/importação) | Manual, portal público | Mensal |
| RAIS + CAGED histórico (até 2019) | Manual, sistema de consulta | Mensal/conforme publicação |
| DECOM (defesa comercial) | Manual, tabela pública | Conforme publicação de resolução |
| Energia Industrial (EPE + MME/ANEEL) | Manual, publicações oficiais | **Não precisa atualizar** (decisão do SIFESP) |

Os scripts de coleta automática e o passo a passo detalhado das fontes
manuais (incluindo qualquer login necessário) **não ficam neste
repositório** — moram em `Setor Siderúrgico/` (fora do controle de
versão) por conterem credenciais e planilhas brutas grandes demais para
um repositório que pode ficar público. Veja
`Setor Siderúrgico/RUNBOOK_ACESSOS.md` para o procedimento completo.

## Extensão para outros CNAEs

A receita de RAIS, CAGED, Comex Stat, DECOM, BNDES e IBGE/PIA é genérica:
troca-se o código do CNAE (e a cesta de NCM correspondente, no caso de
Comex Stat) e o mesmo processo funciona para qualquer setor novo que o
SIFESP queira adicionar ao painel.

A exceção é o bloco **Produção física**: hoje usa Instituto Aço Brasil pro
2451 (aço) e ABAL pro 2452 (alumínio primário), cada fonte específica do
seu metal. Adicionar um setor novo exige achar uma fonte física
equivalente pro metal/produto dele (nem toda associação setorial publica
série mensal); se não existir, o indicador simplesmente fica de fora
daquele setor, como já acontece com DECOM pro 2452 hoje.

Ao adicionar um setor fora do escopo atual do SIFESP, trocar a logo da
barra lateral de `assets/logos/logo-sifesp.png` para
`assets/logos/logo-fiesp.webp` (já existe no repositório) e ajustar o
texto de crédito no rodapé da sidebar.
