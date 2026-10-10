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
| 🗺️ **Rota fixa** | Saída automática (o app mostra “Saindo de: Rua X · Bairro” pelo GPS; toque em *trocar* para sair de outro lugar), paradas obrigatórias ("passar por…") e destino. Escolha entre rotas alternativas. Aceita endereço, coordenadas ou link do Google Maps/Waze. |
| ⬇ **Preparar offline** | Baixa do OpenStreetMap os postos, restaurantes, áreas de descanso, hotéis/motéis e radares ao longo da rota. |
| 🗣️ **Voz** | Usa a voz do próprio celular (offline). Em Ajustes: escolher a voz, velocidade da fala e 🔊 Testar. No iPhone dá pra baixar vozes “Aprimoradas” em Ajustes › Acessibilidade › Conteúdo Falado › Vozes. |
| 🔔 **Modo insistente** (padrão) | Filosofia: melhor avisar demais do que levar multa. Radar e limite **sempre** falam (mesmo com a voz desligada), o aviso de limite repete a cada 15 s enquanto você estiver acima, radares que você negou continuam avisando como “possível radar”, os alertas seguem mesmo fora da rota e o app avisa quando fica sem GPS ou com a tela apagada. |
| 🧭 **Voltar à rota** | Saiu da rota? Uma seta aponta para o trajeto e o botão “Me leve de volta” traça um caminho curto (linha laranja) até a rota original — a rota principal não muda. Sem internet, a voz vai dizendo “a rota fica a 300 metros, à sua esquerda”. |
| 🔒 **Saída segura** | Ao iniciar, a voz e a tela lembram: “Coloque o cinto e acenda os faróis” (de dia: farol baixo na estrada). Se o servidor do mapa demorar para mandar os radares da rota, o app tenta de novo sozinho (1, 2 e 4 min) — seus radares salvos já ficam ativos. |
| 🏁 **Chegada** | Cartão “Você chegou! · Encerrar” (também quando você para perto do destino procurando vaga), sem avisos de “fora da rota” nem instruções (pode dar a volta procurando vaga); encerra sozinho após 2 min parado. |
| 🗣️ **Kravenox companheiro** | Contra o tédio e o sono: de vez em quando ele fala (só voz) frases da história dele — Reino Quebrado, Thornox, Lyra, Sinos do Vazio. Depois de muito tempo ao volante ou de madrugada, fala mais vezes e sugere parar, dizendo onde fica o próximo posto. Nunca fala por cima de avisos. Parado, faz Espinhos Vorazes, Modo Fúria, Salto Predador + Esmagamento e Raio da Essência. |
| 🦖 **Seu ícone** | Ponto/seta azul por padrão; na primeira vez o app mostra a dica “Deixe o app com a sua cara”. Dá pra trocar por seta grande, emojis (🚗 🛻 🏍️ 🦖 🐉…) ou uma imagem sua (ex.: personagem do seu jogo) andando no mapa. |
| 👾 **Kravenox** | O personagem do jogo anda no mapa com a mesma caminhada do jogo e vira para onde você vai. Parado, faz brincadeiras sozinho: pula, ruge, pisa forte, solta fogo e explode prediozinhos de mentira, dorme se a parada passar de 3 min e comemora na chegada. Andando, só uma brincadeira pequena de vez em quando, nunca durante avisos (Ajustes › Brincadeiras do Kravenox). |
| 📷 **Radares** | Avisos por voz e bipe em 1000 m, 500 m e 200 m (ajustável), com limite de velocidade e alerta se estiver acima. |
| ✅ **Confirmar radar** | Ao passar por um radar, o app pergunta "Tinha?" → ✅/❌. Radares negados repetidamente são desativados sozinhos. |
| ➕ **Marcar radar** | Botão vermelho grande: marca um radar onde você está (e o sentido da via) e pergunta o limite. |
| 🕳️ **Buraco, lombada, perigo** | Sem botão novo: toque em **+ RADAR** e, na caixinha, escolha “Não era radar? 🕳️ Buraco · 🚧 Lombada · ⚠️ Perigo”. Nas próximas viagens avisa a 400 m e na hora (“Lombada em 400 metros… Lombada!”), mesmo sem internet. Depois de passar, pergunta se ainda está lá; consertado some sozinho. |
| ⛽ **Postos na estrada** | Próximo posto/restaurante/parada com distância e tempo; destaque para os **24h**; aviso por voz "este foi o último posto pelos próximos X km". |
| 😴 **Cansaço** | Lembrete de pausa a cada 2 h ao volante (1h30 de madrugada), já dizendo onde fica o próximo posto. Parada de 10 min zera o contador. |
| 🧭 **Planeje sua viagem** | Saída, destino e cidades de parada (marque onde quer dormir). O app monta o roteiro dia a dia: pausas a cada 2 h em postos/restaurantes reais da rota (almoço e jantar na hora certa), pernoite sugerido quando passa do limite de horas ao volante, hospedagens perto do pernoite (com links para Booking/Google), pedágios e combustível estimados. Durante a viagem, o app avisa as paradas planejadas. |
| 💰 **Pedágio (estimativa)** | Conta as praças e pórticos free-flow do OpenStreetMap na rota; usa o preço do mapa quando existe e, senão, a tarifa média que você informar. |
| 🅿️ **Paradas fora do plano** | Divergir do roteiro é normal: se você acabou de parar, a pausa planejada seguinte vira “opcional” e fica em silêncio. Parou 2 min? O app pergunta o motivo com botões grandes (😴 sono/lavar o rosto, 🚻, ☕, 🍽️, ⛽…) — ou toque ☕ na tela para registrar. “Sono” zera o contador de cansaço. Fica tudo no histórico da viagem. |
| 🏙️ **Cidades que conheço** | Diário automático das cidades por onde você passou e onde parou, com relatório por estado, mapa e compartilhamento. Funciona offline (descobre os nomes quando voltar a internet). |
| 🚦 **Limite da via** | Placa com o limite do trecho (dados do OpenStreetMap, baixados com a viagem). **Avisa antes das reduções** (“o limite cai para 90 em 700 metros”, ~40 s antes) e, se você entrar no trecho acima do limite, avisa na hora. Fora isso, aviso único quando você passa >10%. Radar sem limite cadastrado usa o da via. |
| ⛽ **Detalhes do lugar** | Toque no card de um posto/restaurante (ou na lista do resumo): horário, 24h, telefone, distância, ver no mapa e Google Maps. |
| 💾 **Backup e exportação** | Backup completo para trocar de celular; histórico em planilha (CSV) e cada trajeto em GPX. |
| 🔎 **Busca esperta** | Sugestões enquanto você digita (como no Waze), com a distância e os mais perto primeiro; tocar numa sugestão já traça a rota. Lugares famosos aparecem no topo mesmo longe (“Aparecida” → 🏙️ a cidade e ⭐ o Santuário, antes das ruas com esse nome). Entende marcas do jeito que se escreve (“mac donalds”, “méqui”, “burguer king”, “habibs”) e mostra **todas** as lojas ao seu redor. Entende “o quê + onde” (ex.: “UPA Caraguatatuba”, “posto Registro”) e sinônimos (UPA → pronto atendimento/pronto-socorro). |
| 🏠 **Lugares fixos** | Casa principal, Trabalho e quantos lugares quiser (Casa da praia, Casa da mãe…). Tocar e segurar num atalho edita/troca o endereço/apaga; alfinete ajustável para marcar a porta certa. Casa, Trabalho e favoritos com ícone: um toque no atalho e a rota já é traçada. Digitar “casa” no destino também funciona. |
| 🕘 **Frequentes** | O app lembra os destinos usados e sugere os mais frequentes. |
| 📍 **Histórico** | Cada viagem fica salva com o trajeto percorrido, km, tempo ao volante, velocidade máxima e radares passados (aba Lugares). |
| ↩ **Volta** | Nas viagens salvas, um toque monta a rota de volta. |
| ⏯ **Retomar** | Se o app fechar no meio da viagem, ao abrir ele oferece continuar de onde parou. |
| 🌙 **Mapa noturno** | Mapa escuro automático das 18h às 6h. |
| 📷 **Modo só radar** | Para o dia a dia: sem rota, só alerta os radares da sua base à frente. |
| 🟢 **Spotify** | Você escolhe a sua trilha preferida (artista ou playlist); com a sua autorização, o app toca ela no Spotify do celular — na abertura e pelo botão 🎵 durante a viagem. |
| 🎵 **Trilha offline** | Alternativa: seus arquivos de música ficam guardados no celular; a música abaixa sozinha durante os avisos. |
| 📥 **Importar base de radares** | Aba Radares › “📥 Importar arquivo de radares”: aceita o zip do Maparadar e os formatos de GPS (CSV/TXT Garmin e iGO, GPX, KML, OV2 TomTom), além do backup do app. Aguenta a base do Brasil inteiro (dezenas de milhares): o mapa desenha só os da área visível. |
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
4. Pronto: escreva a sua trilha preferida (artista ou playlist) ou escolha uma das suas playlists.

Dica: baixe a playlist no app do Spotify para ela tocar nos trechos sem sinal.

## Busca melhor com a TomTom (opcional, grátis)

A busca padrão usa o OpenStreetMap, que às vezes não tem lojas e lugares novos. Com uma chave grátis da TomTom (empresa de GPS que fornece mapas para carros), a busca fica parecida com a do Waze.

1. Entre em [developer.tomtom.com](https://developer.tomtom.com) → **Register** (só e-mail, sem cartão) e confirme o e-mail.
2. No painel (**Dashboard → Keys**) já existe uma chave pronta (“My first API key”). Copie.
3. No app: **Ajustes → 🔎 Busca melhor (TomTom)** → cole → **Testar** → **Salvar**.

Para todo mundo que usar o app sem precisar colar nada, coloque a chave em `js/config.js` (`tomtomKey`). Todos usam a sua cota grátis diária; sem cartão, não há cobrança — se a cota acabar, a busca volta sozinha para o OpenStreetMap até o dia seguinte.

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
js/mascot.js          Kravenox no mapa (caminhada e brincadeiras)
js/planner.js         roteiro dia a dia: pausas, pernoites, pedágio e combustível
js/config.js          Client ID do Spotify embutido (opcional)
js/music.js           player offline
js/spotify.js         autorização e controle do Spotify
js/voice.js           voz pt-BR e bipes
js/store.js           armazenamento no celular (IndexedDB)
sw.js                 funcionamento offline
```

Dados de mapa © colaboradores do OpenStreetMap. Uso pessoal, não comercial.
