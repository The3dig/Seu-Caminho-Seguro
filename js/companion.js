// Kravenox companheiro: contra o tédio e o sono numa viagem longa, ele fala
// de vez em quando (só voz, nada na tela), com coisas da história dele
// (Reino Quebrado, Thornox, Lyra, Sinos do Vazio…). Nunca fala por cima de
// avisos de radar, limite, manobra perto ou fora da rota. Depois de muito
// tempo ao volante, ou de madrugada, fala mais vezes e sugere parar.
import { speak } from './voice.js';

const LINES = [
  'A Essência ainda vive. E a estrada também. Siga.',
  'Não há luz sem sombra. Nem viagem sem um pouco de tédio. Aguente firme.',
  'Atravessei o Reino Quebrado inteiro a pé. Você tem um carro. Não reclame.',
  'Thornox dirigiria devagar e com as duas mãos no volante. Às vezes ele tinha razão demais.',
  'Sempre existe uma porta que exige alguma coisa. Esta estrada exige atenção.',
  'As Larvas da Essência racham o chão por onde passam. Desconfio que algumas passaram por aqui.',
  'Na Cidade Submersa havia sete sinos. Aqui eu só preciso de um bipe por radar.',
  'Espinhos Vorazes prontos. Mas hoje quem manda é o limite de velocidade.',
  'Lyra diria que toda estrada guarda uma memória. Esta guarda radar.',
  'Finalmente alguma coisa interessante... Não. Era só mais um caminhão.',
  'Despertei no Abismo Carmesim para isso? Para ver asfalto? Tudo bem. Eu gosto de asfalto.',
  'O Grande Cisma rasgou o mundo. Um buraco na estrada não vai nos parar.',
  'Tudo que foi tomado, eu vou recuperar. Inclusive o tempo deste trânsito.',
  'Os Sinos do Vazio estão em silêncio. Bom sinal. Continue atento.',
  'Na Vila Sem Nome as casas estavam vazias. Espero que no nosso destino tenha café.',
  'Minhas garras não seguram volante. Por isso eu confio em você.',
  'Salto Predador seria mais rápido. Mas a rota é fixa, e eu respeito a rota.',
  'Ouvi dizer que existe uma coisa chamada lanchonete de estrada. Quando pararmos, eu quero ver.',
  'A Sentinela sem Rosto também não piscava. Mas ela não estava dirigindo.',
  'Valdora ardeu em chamas e eu segui em frente. Nós vamos seguir também.',
];
const TIRED = [
  'Ei. Seus olhos estão pesados como cristal do Cisma? Se bater sono, a gente para.',
  'Até eu, que dormi séculos no Abismo, sei a hora de descansar. Que tal uma parada?',
  'O sono é o inimigo mais traiçoeiro. Pior que a Sentinela sem Rosto. Pare, lave o rosto, tome um café.',
  'Já faz tempo que estamos rodando. Um café agora valeria um Fragmento da Essência.',
];
const NIGHT = [
  'A noite é o meu território. Mas os faróis são seus. Mantenha acesos.',
  'No escuro, olhos vermelhos enxergam. Os seus precisam de descanso de vez em quando.',
  'Noite boa para atravessar o Reino. Devagar e atento.',
];

const rand = (a, b) => a + Math.random() * (b - a);

export class Companion {
  constructor() {
    this.next = Date.now() + rand(6, 10) * 60000; // primeira fala depois de uns minutos
    this.used = new Set();
  }

  pick(list) {
    let free = list.filter((l) => !this.used.has(l));
    if (!free.length) { list.forEach((l) => this.used.delete(l)); free = list; }
    const l = free[Math.floor(Math.random() * free.length)];
    this.used.add(l);
    return l;
  }

  // st = estado da navegação; ctx = { movingSec, night, fuelKm }
  tick(st, { movingSec = 0, night = false, fuelKm = null } = {}) {
    const now = Date.now();
    if (now < this.next) return null;
    if (st.kmh < 15 || st.arrived) return null;
    // Nada por cima de avisos: espera a próxima chance.
    if (st.radar || st.off || st.limitDrop || st.overRoad || (st.stepDist != null && st.stepDist < 1500)) return null;
    const tired = movingSec > 90 * 60 || (night && movingSec > 45 * 60);
    let line;
    if (tired && Math.random() < 0.6) {
      line = this.pick(TIRED) + (fuelKm != null && fuelKm < 80 ? ` O próximo posto fica a ${Math.max(1, Math.round(fuelKm))} quilômetros.` : '');
    } else if (night && Math.random() < 0.3) line = this.pick(NIGHT);
    else line = this.pick(LINES);
    speak(line);
    const gap = tired ? 10 : night ? 15 : 22;
    this.next = now + (gap + rand(0, 8)) * 60000;
    return line;
  }
}
