# LANDINGPAGE.md — Plano da landing page pública do Hollycode

> Página atual: `C:\OneDrive\OneDrive - Bedroom Elegance\Desktop\TEKEGRAM\hollycode.html`
> (clone visual da landing do opencode, gerada pelo bot via Telegram).
> Objetivo: transformá-la na página oficial para QUALQUER pessoa baixar e
> instalar o Hollycode, igual ao opencode. TUDO público em INGLÊS.

## 0. Pré-requisitos (antes de publicar qualquer coisa)

1. **Tornar o repo público** (github.com/Davienzomq/hollywood-code é PRIVADO hoje).
   - Conferir que nenhum segredo foi commitado (tokens ficam em ~/.config/hollywood/, ok)
   - LICENSE do upstream opencode preservada (MIT) + atribuição do fork no README
   - README.md em inglês: o que é (opencode fork + stuntdouble router nativo),
     features próprias (auto-cast, /remote-control Telegram, orchestration),
     install, screenshots/gif
2. **Decidir o branch público**: `main` limpo (sem CI do upstream) já existe — publicar dele.

## 1. Instalação real (o que a página deve mostrar)

### Fase A — clone-based installer (funciona JÁ, sem build de binário)
Criar na raiz do repo (copiar padrão do stuntdouble install.sh/ps1):
- **install.ps1** (Windows): instala bun se faltar (`irm bun.sh/install.ps1|iex`),
  `git clone --depth 1 https://github.com/Davienzomq/hollywood-code $HOME\.hollycode`,
  `bun install` na raiz, cria launchers em `$HOME\.bun\bin` (já no PATH do bun):
  - `hollycode.cmd` → pushd `%USERPROFILE%\.hollycode\packages\opencode` + `bun run src/index.ts` com cwd original (espelhar o hollycode.cmd local de C:\Users\bespa\.bun\bin)
  - `hollycode-remote.cmd` → `bun run %USERPROFILE%\.hollycode\packages\telegram\bin\hollycode-remote.ts`
- **install.sh** (mac/linux): mesmo fluxo com `curl -fsSL bun.sh/install | bash`, clone, symlinks em ~/.bun/bin
- Comandos da página:
  - Windows: `irm https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.ps1 | iex`
  - mac/linux: `curl -fsSL https://raw.githubusercontent.com/Davienzomq/hollywood-code/main/install.sh | bash`

### Fase B — binários (depois): `bun build --compile` por plataforma → GitHub Releases
→ aí o installer baixa binário em vez de clonar (UX igual opencode). `hollycode upgrade` futuro.

## 2. Hospedagem da página
- A landing vive em **`site/`** no repo: `site/index.html` + `site/demo.gif`
  (HTML estático auto-contido, GIF referenciado por caminho relativo).
- **GitHub Pages**: Settings → Pages → Source = branch `main`, folder `/site`
  (ou renomear para `/docs` se preferir o padrão) → URL
  `https://davienzomq.github.io/hollywood-code/`.
- Domínio próprio (hollycode.dev) só se comprar — CNAME no Pages. Os comandos
  de install já exibem `hollycode.dev/install` mas copiam a URL raw do GitHub.

## 3. Correções obrigatórias no HTML (honestidade + funcionamento)

| Item | Hoje | Deve ser |
|---|---|---|
| Stats "160K stars / 900 contributors / 7.5M devs" | números do OPENCODE (mentira p/ nós) | REMOVER. Trocar por stats honestos: "31+ commands · 75+ providers · ~40% cost savings via auto-casting" |
| Install box `curl https://hollycode.dev/install` | domínio não existe | comandos da Fase A acima; tabs (PowerShell/curl/git) trocando o comando de verdade via JS |
| Tabs npm/brew/paru | não temos | remover; deixar: PowerShell · curl · git clone |
| Links nav/footer "#" | mortos | GitHub → repo real; Docs → README; Discord/X → remover ou criar; Zen → seção própria explicando o router (não o zen do opencode) |
| "GitHub Copilot / ChatGPT Plus" cards | herdados do opencode (valem, é fork) | manter, mas ADICIONAR os diferenciais Hollywood (ver §4) |
| FAQ "Apache 2.0" | errado | MIT (licença do opencode) |
| Waitlist com email | sem backend, não funciona | trocar por botão "Watch releases on GitHub" |
| Logo | `<Hollycode/>` ok | manter wordmark HOLLYCODE consistente (TUI mostra HOLLY CODE) + 🎬 |
| Title/meta | genérico | "Hollycode — the AI coding agent that casts the right model for every scene" |

## 4. Seção NOVA: os diferenciais Hollywood (o motivo da página existir)
Cards/section "Why Hollycode?" acima das features herdadas:
1. **🎬 Stuntdouble router** — every message is scored and cast automatically:
   cheap chat → stunt doubles (flash/mini), hard tasks → the star. Proven live:
   "oi" → deepseek-flash, architecture → big-pickle. Zero config.
2. **📱 Telegram remote control** — `/remote-control` wizard (1 command), work
   from your phone, permission requests arrive as Approve/Deny buttons,
   bot survives closing every window (real daemon).
3. **🎭 Orchestration** — big tasks decomposed to parallel subagents, each
   cast by content; the star only enters at the end to verify.
4. **💰 /cost** — see exactly how much the stunt doubles saved you per session.

## ⚠️ Dois produtos, dois instaladores (NÃO confundir)
- **stuntdouble** (a SKILL, repo Davienzomq/stuntdouble): instalador em
  `SKILL/install.ps1` baixa ZIP → copia skill para `~/.claude/skills/`.
  É uma skill do Claude Code, NÃO precisa de bun nem cria launcher de app.
- **hollycode** (o APP, este repo Davienzomq/hollywood-code): instalador
  `install.ps1`/`install.sh` na raiz — clona repo → bun install → cria
  launchers `hollycode` + `hollycode-remote` em ~/.bun/bin. A landing page
  é do APP, então usa ESTE instalador.
- Ideia herdada do instalador da skill: usar download de ZIP
  (Invoke-WebRequest/Expand-Archive) dispensa `git` no cliente — considerar
  como fallback no install.ps1 do app (hoje exige git clone, melhor p/ updates).

## 5. Done / em andamento
- [x] Plano salvo (este arquivo)
- [x] Melhorar hollycode.html (branding HOLLYCODE 🎬 tema cinema dourado, stats
      honestos, seção "Why" com diferenciais, install tabs reais, links GitHub,
      MIT, FAQ atualizado) — em TEKEGRAM/hollycode.html
- [x] /cost no Telegram (relatório por modelo + economia vs all-star). Bug do
      shape de cache (cost.cache.read, não cache_read) corrigido. Testar live!
- [x] install.ps1 / install.sh no repo (clone-based, Fase A) — sintaxe validada
- [ ] /cost no TUI — adiado (sidebar já mostra custo)
- [ ] README público em inglês
- [ ] Repo público + GitHub Pages
- [ ] (Fase B) binários compilados + releases

## Regras
- NADA de commit até o usuário testar (pedido explícito 2026-06-12)
- Tudo público em inglês; números só se forem verdadeiros
- Página final deve ser 1 HTML estático auto-contido (fácil de hospedar no Pages)
