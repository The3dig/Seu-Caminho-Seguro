# Seu Caminho Seguro

App pessoal de navegação para estrada, pensado para três problemas:

1. **Radares que o Waze não avisa** → você tem sua própria base de radares, que vai sendo **confirmada por você** a cada viagem.
2. **Desvios perigosos** → a rota é definida **antes** de sair e **nunca é recalculada**, nem com trânsito.
3. **Sono sem saber onde parar** → o app mostra sempre a distância até o **próximo posto, restaurante, parada e hotel**, e avisa quando vem um trecho longo sem posto.

Funciona no navegador do celular e pode ser instalado na tela inicial (PWA). Depois de preparada, a viagem funciona **sem internet**.

## Funções

| | |
|---|---|
| 🌅 **Abertura "boa viagem"** | Tela animada de pôr do sol com a sua trilha (ex.: Nat King Cole) tocando. |
| 🗺️ **Rota fixa** | Saída, paradas obrigatórias ("passar por…") e destino. Escolha entre rotas alternativas. Aceita endereço, coordenadas ou link do Google Maps/Waze. |
| ⬇ **Preparar offline** | Baixa do OpenStreetMap os postos, restaurantes, áreas de descanso, hotéis/motéis e radares ao longo da rota. |
| 📷 **Radares** | Avisos por voz e bipe em 1000 m, 500 m e 200 m (ajustável), com limite de velocidade e alerta se estiver acima. |
| ✅ **Confirmar radar** | Ao passar por um radar, o app pergunta "Tinha?" → ✅/❌. Radares negados repetidamente são desativados sozinhos. |
| ➕ **Marcar radar** | Botão vermelho grande: marca um radar onde você está (e o sentido da via) e pergunta o limite. |
| ⛽ **Postos na estrada** | Próximo posto/restaurante/parada com distância e tempo; destaque para os **24h**; aviso por voz "este foi o último posto pelos próximos X km". |
| 😴 **Cansaço** | Lembrete de pausa a cada 2 h ao volante (1h30 de madrugada), já dizendo onde fica o próximo posto. Parada de 10 min zera o contador. |
| 🧭 **Planeje sua viagem** | Saída, destino e cidades de parada (marque onde quer dormir). O app monta o roteiro dia a dia: pausas a cada 2 h em postos/restaurantes reais da rota (almoço e jantar na hora certa), pernoite sugerido quando passa do limite de horas ao volante, hospedagens perto do pernoite (com links para Booking/Google), pedágios e combustível estimados. Durante a viagem, o app avisa as paradas planejadas. |
| 💰 **Pedágio (estimativa)** | Conta as praças e pórticos free-flow do OpenStreetMap na rota; usa o preço do mapa quando existe e, senão, a tarifa média que você informar. |
| 🅿️ **Paradas fora do plano** | Parou 2 min? O app pergunta o motivo com botões grandes (😴 sono/lavar o rosto, 🚻, ☕, 🍽️, ⛽…) — ou toque ☕ na tela para registrar. “Sono” zera o contador de cansaço. Fica tudo no histórico da viagem. |
| 🏙️ **Cidades que conheço** | Diário automático das cidades por onde você passou e onde parou, com relatório por estado, mapa e compartilhamento. Funciona offline (descobre os nomes quando voltar a internet). |
| 🏠 **Lugares fixos** | Casa, Trabalho e favoritos com ícone: um toque no atalho e a rota já é traçada. Digitar “casa” no destino também funciona. |
| 🕘 **Frequentes** | O app lembra os destinos usados e sugere os mais frequentes. |
| 📍 **Histórico** | Cada viagem fica salva com o trajeto percorrido, km, tempo ao volante, velocidade máxima e radares passados (aba Lugares). |
| ↩ **Volta** | Nas viagens salvas, um toque monta a rota de volta. |
| ⏯ **Retomar** | Se o app fechar no meio da viagem, ao abrir ele oferece continuar de onde parou. |
| 🌙 **Mapa noturno** | Mapa escuro automático das 18h às 6h. |
| 📷 **Modo só radar** | Para o dia a dia: sem rota, só alerta os radares da sua base à frente. |
| 🟢 **Spotify** | Com a sua autorização, o app toca o Nat King Cole (ou qualquer playlist sua) no Spotify do celular — na abertura e pelo botão 🎵 durante a viagem. |
| 🎵 **Trilha offline** | Alternativa: seus arquivos de música ficam guardados no celular; a música abaixa sozinha durante os avisos. |
| 💾 **Backup** | Exporta/importa radares (JSON, CSV, GPX, KML — dá pra importar listas feitas no Google My Maps). |

## Como colocar no celular

O app é só um site estático (HTML/JS), sem servidor. O jeito mais fácil é o **GitHub Pages**:

1. No GitHub, abra o repositório → **Settings → Pages**.
2. Em *Source*, escolha **Deploy from a branch**, branch `main` (ou a branch deste app) e pasta `/ (root)`.
3. Em ~1 min o endereço aparece (algo como `https://SEU-USUARIO.github.io/Seu-Caminho-Seguro/`).
4. Abra no **Chrome do Android** (ou Safari no iPhone) → menu → **Adicionar à tela inicial**.

> O GPS só funciona em `https://` (ou `localhost`), por isso o GitHub Pages é ideal.

Para testar no computador: `python3 -m http.server 8000` na pasta do projeto e abra `http://localhost:8000`.

## Conectar o Spotify (uma vez)

Requer **Spotify Premium** (exigência do Spotify para apps que controlam a música).

1. Abra o app já publicado (endereço do GitHub Pages) → aba 🎵 → **Spotify**. Ali aparece o *Redirect URI* para copiar.
2. Em [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app** → cole o *Redirect URI*, marque **Web API**, salve.
3. Copie o **Client ID**, cole no app e toque em **Autorizar Spotify**. O Spotify pergunta se você permite → **Concordo**.
4. Pronto: a trilha padrão é o artista Nat King Cole; dá pra buscar outra playlist ou escolher uma das suas.

Dica: baixe a playlist no app do Spotify para ela tocar nos trechos sem sinal.

## Antes de viajar (com internet)

1. **Viagem** → digite o destino → **Traçar rota** → escolha a rota → **Preparar viagem offline**.
2. Confira o resumo: quantos radares, postos, e os **trechos longos sem posto**.
3. Passe o dedo pelo mapa ao longo da rota para as imagens do mapa ficarem salvas (o restante já está offline).
4. Use **🧪 Simular** para ver o app "dirigindo sozinho" pela rota e ouvir os avisos.
5. Na estrada: **▶ Iniciar viagem**. Deixe o celular na tomada (GPS + tela ligada gastam bateria).

## Limitações honestas

- **Radares do Waze/Google não podem ser importados**: eles não liberam esses dados. A base começa com os radares cadastrados no OpenStreetMap (marcados como "não confirmados") e vai ficando boa conforme você marca e confirma.
- **Spotify**: só controla a música com Premium e com internet (o próprio Spotify continua tocando músicas baixadas sem sinal). Se o Spotify não estiver aberto, o app abre ele para você. A voz dos avisos não abaixa o volume do Spotify automaticamente em todos os celulares.
- **Arquivos próprios**: as músicas não vêm com o app (direitos autorais); adicione seus MP3/M4A na aba 🎵 se quiser algo 100% offline.
- Postos e restaurantes vêm do OpenStreetMap: na maioria das rodovias brasileiras está bem completo, mas pode faltar algum estabelecimento ou horário.
- Rotas: servidor público do OSRM; busca de endereços: Nominatim. Ambos gratuitos e para uso leve — perfeito para uso pessoal.
- Se você sair da rota, o app **avisa mas não recalcula** (de propósito). Para mudar o caminho, prepare uma nova viagem.

## Estrutura

```
index.html            telas
css/style.css         visual
js/app.js             interface e fluxo
js/nav.js             motor de navegação (rota fixa, radares, postos, cansaço)
js/routing.js         busca de endereço + rota (OSRM) + instruções em português
js/pois.js            postos/restaurantes/radares via OpenStreetMap (Overpass)
js/radars.js          base pessoal de radares + importação/exportação
js/places.js          lugares fixos, recentes, histórico e retomada
js/cities.js          diário de cidades (passou / parou)
js/planner.js         roteiro dia a dia: pausas, pernoites, pedágio e combustível
js/config.js          Client ID do Spotify embutido (opcional)
js/music.js           player offline
js/spotify.js         autorização e controle do Spotify
js/voice.js           voz pt-BR e bipes
js/store.js           armazenamento no celular (IndexedDB)
sw.js                 funcionamento offline
```

Dados de mapa © colaboradores do OpenStreetMap. Uso pessoal, não comercial.
