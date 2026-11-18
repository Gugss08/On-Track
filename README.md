# On track

App pessoal para marcar tarefas, hábitos e metas, registar se foram cumpridos e ver as estatísticas.
É uma web app instalável (PWA): no iPhone, abre o link no Safari → Partilhar → Adicionar ao ecrã principal.

## Como está feita
- `src/` — código da app (HTML, CSS e `main.js`), num só ecrã com três separadores: Hoje, Lista, Estatísticas.
- `src/firebase-config.js` — configuração pública do projeto Firebase.
- `public/` — manifesto, service worker (funciona sem internet) e ícones.
- `firestore.rules` — regras de segurança: cada conta só vê os seus dados (`users/{uid}/...`).
- `.github/workflows/deploy.yml` — cada push para `main` gera a app e publica-a no GitHub Pages.

## Regras de contagem
- Tarefa com dia que passa sem estar feita conta como **não feita** (automático). Pode ser corrigida.
- Hábitos em dias certos: cada dia marcado é uma ocorrência. Hábitos "X por semana": as que faltarem no fim da semana contam como não feitas.
- Cumprimento = feitas ÷ (feitas + não feitas). O que ainda está por fazer não entra.

## Desenvolver
```
npm ci
node build.mjs     # gera dist/
npx serve dist     # pré-visualizar
```
