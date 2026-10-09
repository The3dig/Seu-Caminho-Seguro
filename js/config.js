// Configurações fixas do app (valem para todos os celulares que abrirem o site).
export const CONFIG = {
  // Client ID de um app criado uma única vez em developer.spotify.com (não é
  // segredo). Preenchido aqui, qualquer pessoa só toca em "Conectar Spotify",
  // sem configurar nada. Vazio = cada um pode colar o seu em Músicas.
  spotifyClientId: '',
  // Chave grátis da TomTom (developer.tomtom.com) para a busca de lugares.
  // Preenchida aqui, vale para todo mundo que abrir o app. Vazio = cada um
  // pode colar a sua em Ajustes; sem chave, usa a busca gratuita do OpenStreetMap.
  tomtomKey: '',
};
