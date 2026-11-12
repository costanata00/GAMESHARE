// GameShare — translations.
//
// The app's text is written in English in the code and passed through tr().
// Each language below maps that English text to its own. {name}-style slots
// are filled in by tr(). Anything missing from a language stays in English.
//
// To add a language: copy the `pt` block, translate the right-hand side, add
// it to LANGS and LANG_NAMES, and add an <option> to the two language menus in
// index.html.
'use strict';

const PT = {
  // ---- start screen
  'Talk and watch each other play. Straight from PC to PC, up to 10 players.':
    'Conversem e assistam uns aos outros jogando. Direto de PC para PC, até 10 jogadores.',
  'Your name': 'Seu nome',
  'e.g. Nata': 'ex.: Nata',
  'Room size': 'Tamanho da sala',
  'Create a room': 'Criar sala',
  'or join a friend': 'ou entre na sala de um amigo',
  'Room code': 'Código da sala',
  'Join': 'Entrar',
  'Rejoin room': 'Voltar à sala',
  'Language': 'Idioma',
  'Automatic': 'Automático',
  'Pick a name first.': 'Escolha um nome primeiro.',
  'Room codes are 6 characters.': 'O código da sala tem 6 caracteres.',
  'No room with that code. Check it and try again.': 'Não existe sala com esse código. Confira e tente de novo.',
  'Creating room…': 'Criando a sala…',
  'Joining…': 'Entrando…',
  'Getting you back into room {code}…': 'Te colocando de volta na sala {code}…',
  'Rejoining room {code}…': 'Voltando à sala {code}…',
  'Room {code} was empty, opening it again…': 'A sala {code} estava vazia, abrindo de novo…',
  'Room {code} is open again. Friends can join with the same code.':
    'A sala {code} está aberta de novo. Os amigos podem entrar com o mesmo código.',
  'Couldn’t reach the connection server. Check your internet and try again.':
    'Não foi possível falar com o servidor de conexão. Confira sua internet e tente de novo.',
  'Couldn’t reopen room {code} yet. Try again in a minute, or create a new room.':
    'Ainda não deu para reabrir a sala {code}. Tente de novo daqui a um minuto ou crie uma sala nova.',
  'Couldn’t create a room right now. Try again.': 'Não foi possível criar uma sala agora. Tente de novo.',
  'The room didn’t answer. Make sure your friend is still in it.':
    'A sala não respondeu. Confira se seu amigo ainda está nela.',
  'That room is full ({n} players). Ask the host to make it bigger in Settings.':
    'Essa sala está cheia ({n} jogadores). Peça ao anfitrião para aumentá-la em Configurações.',
  'You were disconnected and room {code} filled up meanwhile ({n} players).':
    'Você foi desconectado e a sala {code} lotou nesse meio-tempo ({n} jogadores).',
  'You left the room.': 'Você saiu da sala.',
  'You': 'Você',
  '{n} players': '{n} jogadores',
  'Room for {n} players': 'Sala para {n} jogadores',

  // ---- side panel
  'Room': 'Sala',
  'GameShare · Room {code}': 'GameShare · Sala {code}',
  'Collapse the panel (Ctrl+Shift+P)': 'Recolher o painel (Ctrl+Shift+P)',
  'Expand the panel (Ctrl+Shift+P)': 'Expandir o painel (Ctrl+Shift+P)',
  'Players in the room / room size': 'Jogadores na sala / tamanho da sala',
  'Copy an invite with the room code': 'Copiar um convite com o código da sala',
  'Copy invite': 'Copiar convite',
  'Join me on GameShare! Room code: {code}': 'Entra comigo no GameShare! Código da sala: {code}',
  'Invite copied. Paste it to your friends.': 'Convite copiado. Cole para seus amigos.',
  'Room code: {code}': 'Código da sala: {code}',
  'Connecting…': 'Conectando…',
  'Connected': 'Conectado',
  'Waiting for friends': 'Esperando os amigos',
  'Reconnecting…': 'Reconectando…',
  'Reconnecting to the server…': 'Reconectando ao servidor…',
  'Reconnecting to {name}…': 'Reconectando com {name}…',
  'Reconnecting to {n} friends…': 'Reconectando com {n} amigos…',
  'Your connection dropped. Reconnecting…': 'Sua conexão caiu. Reconectando…',
  'Players': 'Jogadores',
  'Share your screen': 'Compartilhar sua tela',
  'Share screen': 'Compartilhar tela',
  'Stop sharing': 'Parar de compartilhar',
  'Mute': 'Silenciar',
  'Unmute': 'Reativar',
  'Mute (Ctrl+Shift+M)': 'Silenciar (Ctrl+Shift+M)',
  'Mute your mic (Ctrl+Shift+M)': 'Silenciar seu microfone (Ctrl+Shift+M)',
  'Unmute your mic (Ctrl+Shift+M)': 'Reativar seu microfone (Ctrl+Shift+M)',
  'Mute voices': 'Silenciar vozes',
  'Voices': 'Vozes',
  'Voices off': 'Sem vozes',
  'Mute everyone’s voice for you. Streams keep playing (Ctrl+Shift+D)':
    'Silenciar a voz de todos só para você. As transmissões continuam tocando (Ctrl+Shift+D)',
  'Hear everyone’s voice again (Ctrl+Shift+D)': 'Voltar a ouvir a voz de todos (Ctrl+Shift+D)',
  'Settings': 'Configurações',
  'Leave': 'Sair',
  'Leave the room': 'Sair da sala',

  // ---- players
  'Friend': 'Amigo',
  '{name} (you)': '{name} (você)',
  '{name} · reconnecting…': '{name} · reconectando…',
  '{name} joined': '{name} entrou',
  '{name} left': '{name} saiu',
  '{name} lost connection': '{name} perdeu a conexão',
  '{name} started sharing': '{name} começou a compartilhar',
  'and': 'e',
  '{n} friends': '{n} amigos',
  '{who} is back': '{who} voltou',
  '{who} are back': '{who} voltaram',
  'Lost the connection to {who}. Reconnecting…': 'A conexão com {who} caiu. Reconectando…',
  'Host: can change the room size': 'Anfitrião: pode mudar o tamanho da sala',
  'Volume and options': 'Volume e opções',
  'Live': 'Ao vivo',
  'Voices muted': 'Vozes silenciadas',
  'Can’t hear voices': 'Não ouve vozes',
  'Muted for you': 'Silenciado para você',
  'Old version': 'Versão antiga',
  '{name} is running an older GameShare. Ask them to update so everything works the same for everyone.':
    '{name} está usando um GameShare mais antigo. Peça para atualizar, assim tudo funciona igual para todos.',
  'Show my preview': 'Mostrar minha prévia',
  'Watch screen': 'Assistir à tela',
  'Your mic is off': 'Seu microfone está desligado',
  '{name}’s mic is off': 'O microfone de {name} está desligado',
  'You muted everyone’s voice': 'Você silenciou a voz de todos',
  '{name} can’t hear voices right now': '{name} não está ouvindo as vozes agora',
  'Unmute {name}’s voice for me': 'Voltar a ouvir a voz de {name}',
  'Mute {name}’s voice for me (their stream has its own volume)':
    'Silenciar a voz de {name} para mim (a transmissão tem volume próprio)',
  'Connection lost. Reconnecting…': 'Conexão perdida. Reconectando…',
  'Connection: measuring…': 'Conexão: medindo…',
  'Ping {rtt} ms, {loss}% lost, direct': 'Ping {rtt} ms, {loss}% de perda, conexão direta',
  'Ping {rtt} ms, {loss}% lost, going through a relay server':
    'Ping {rtt} ms, {loss}% de perda, via servidor de retransmissão',
  'Couldn’t reach a friend directly — their network may be blocking it.':
    'Não foi possível conectar direto com um amigo; a rede dele pode estar bloqueando.',
  'Room size is now {n} players': 'A sala agora é para {n} jogadores',

  // ---- player menu
  'Player options': 'Opções do jogador',
  'Voice volume': 'Volume da voz',
  'Mute their voice for me': 'Silenciar essa voz para mim',
  'reconnecting…': 'reconectando…',
  'sharing their screen': 'compartilhando a tela',
  'mic off': 'microfone desligado',
  'can’t hear voices': 'não ouve vozes',
  'in the room': 'na sala',
  'Watch their screen': 'Assistir à tela',
  'Close their screen': 'Fechar a tela',

  // ---- settings
  'Voice': 'Voz',
  'Microphone': 'Microfone',
  'Microphone {n}': 'Microfone {n}',
  'Speakers {n}': 'Caixas de som {n}',
  'Talk to test your microphone': 'Fale para testar seu microfone',
  'Speakers or headset': 'Caixas de som ou fone',
  'Where friends’ voices and their streams play': 'Onde tocam as vozes dos amigos e as transmissões deles',
  'System default': 'Padrão do sistema',
  'System default ({name})': 'Padrão do sistema ({name})',
  'Disconnected device': 'Dispositivo desconectado',
  'Remove background noise': 'Remover ruído de fundo',
  'Filters out keyboard, fans and game sound picked up by your mic':
    'Filtra teclado, ventoinhas e som do jogo captados pelo seu microfone',
  'Headphones mode': 'Modo fone de ouvido',
  // ---- soundboard
  'Sounds': 'Sons',
  'Sound': 'Som',
  'Soundboard': 'Soundboard',
  'Soundboard: play a sound to everyone in the room': 'Soundboard: toque um som para todos na sala',
  'Click a sound and everyone in the room hears it, even while you’re muted. Click it again to stop.':
    'Clique em um som e todos na sala ouvem, mesmo com você silenciado. Clique de novo para parar.',
  'Add sounds…': 'Adicionar sons…',
  'Soundboard volume': 'Volume da soundboard',
  'No sounds yet. Add audio files (MP3, WAV, OGG…) and they stay saved on this computer.':
    'Nenhum som ainda. Adicione arquivos de áudio (MP3, WAV, OGG…) e eles ficam salvos neste computador.',
  'Remove “{name}”': 'Remover “{name}”',
  '“{name}” removed': '“{name}” removido',
  'Couldn’t read “{name}” as audio.': 'Não deu para ler “{name}” como áudio.',
  '“{name}” is too big (over {n} MB).': '“{name}” é grande demais (mais de {n} MB).',
  '“{name}” is too long (over {n} s).': '“{name}” é longo demais (mais de {n} s).',
  'The soundboard is full ({n} sounds). Remove one first.': 'A soundboard está cheia ({n} sons). Remova um antes.',
  'Couldn’t save the sound on this computer.': 'Não deu para salvar o som neste computador.',
  'Couldn’t play that sound.': 'Não deu para tocar esse som.',
  '{n} sound added': '{n} som adicionado',
  '{n} sounds added': '{n} sons adicionados',
  'Lower streams while friends talk': 'Abaixar os streams quando alguém fala',
  'Turns shared screens’ sound down a little while someone is speaking, so you hear them over the film.':
    'Abaixa um pouco o som das telas compartilhadas enquanto alguém fala, para você ouvir a pessoa por cima do filme.',
  'Stream volume while friends talk': 'Volume do stream enquanto alguém fala',
  'Streams play at {n}% of their volume while a friend talks': 'Os streams tocam a {n}% do volume enquanto um amigo fala',
  'Clearer voice with echo cancellation off. Only with headphones.':
    'Voz mais limpa, com o cancelamento de eco desligado. Só com fone de ouvido.',
  'How many players can be in this room': 'Quantos jogadores cabem nesta sala',
  'How many players fit, up to {n}': 'Quantos jogadores cabem, até {n}',
  'Only {name} can change it': 'Só {name} pode mudar',
  'you': 'você',
  'the host': 'o anfitrião',
  'Fewer players': 'Menos jogadores',
  'More players': 'Mais jogadores',
  'Sharing': 'Compartilhamento',
  'Share quality': 'Qualidade da transmissão',
  'For your own screen. Stays smooth when your PC or connection is busy.':
    'Da sua própria tela. Continua fluida quando seu PC ou sua conexão estão sobrecarregados.',
  'Bitrate': 'Taxa de bits',
  'The most each friend gets from you. Higher is sharper in fast games but uses more upload. Lower it if friends stutter.':
    'O máximo que cada amigo recebe de você. Mais alta deixa jogos rápidos mais nítidos, mas usa mais upload. Abaixe se travar para os amigos.',
  'Automatic ({n} Mbps)': 'Automática ({n} Mbps)',
  'Bitrate updated': 'Taxa de bits atualizada',
  'Sharing mode': 'Modo de compartilhamento',
  'Game': 'Jogo',
  'Video': 'Vídeo',
  'For playing: the lowest delay.': 'Para jogar: o menor atraso.',
  'For films and videos: steady picture, richer sound. Friends see it about 1 s late.':
    'Para filmes e vídeos: imagem estável e som melhor. Os amigos veem com cerca de 1 s de atraso.',
  'Watching a video? Use Video mode': 'Vai assistir a um vídeo? Use o modo Vídeo',
  'App': 'Aplicativo',
  'In-game overlay': 'Overlay no jogo',
  'Shows who’s talking on top of your game. Works with borderless and windowed games.':
    'Mostra quem está falando por cima do jogo. Funciona com jogos em janela e em janela sem bordas.',
  'Overlay corner': 'Canto do overlay',
  'Top left': 'Superior esquerdo',
  'Top right': 'Superior direito',
  'Bottom left': 'Inferior esquerdo',
  'Bottom right': 'Inferior direito',
  'Sound effects': 'Efeitos sonoros',
  'Joins, leaves, shares and mute': 'Entradas, saídas, transmissões e silenciar',
  'Shortcuts work in games': 'Atalhos funcionam nos jogos',
  'Mute keys work while a game has focus. Turn off if they clash with another app.':
    'As teclas de silenciar funcionam com o jogo em primeiro plano. Desligue se conflitarem com outro programa.',
  'mute': 'silenciar',
  'mute voices': 'silenciar vozes',
  'collapse the panel': 'recolher o painel',
  'Something not working?': 'Algo não funciona?',
  'Copies a report on your connection, devices and settings to paste to whoever helps you. Screens also have a Stats button.':
    'Copia um relatório da sua conexão, dispositivos e configurações para colar para quem for te ajudar. As telas também têm um botão Dados.',
  'Copy report': 'Copiar relatório',
  'Report copied. Paste it to whoever is helping you.': 'Relatório copiado. Cole para quem estiver te ajudando.',
  'Couldn’t copy the report.': 'Não foi possível copiar o relatório.',
  'Headphones mode on: echo cancellation off for clearer voice.':
    'Modo fone de ouvido ligado: cancelamento de eco desligado para uma voz mais limpa.',
  'Headphones mode off: echo cancellation on.': 'Modo fone de ouvido desligado: cancelamento de eco ligado.',
  'Overlay on: it shows who’s talking while you’re in another window, like your game.':
    'Overlay ligado: mostra quem está falando enquanto você está em outra janela, como o seu jogo.',
  'Quality updated': 'Qualidade atualizada',

  // ---- microphone
  'Your chosen microphone isn’t connected. Using the system default.':
    'O microfone escolhido não está conectado. Usando o padrão do sistema.',
  'Background noise removal couldn’t start. Using the standard noise filter.':
    'A remoção de ruído de fundo não conseguiu iniciar. Usando o filtro de ruído padrão.',
  'No microphone found. You can listen and share, but others won’t hear you.':
    'Nenhum microfone encontrado. Você pode ouvir e compartilhar, mas ninguém vai te ouvir.',
  'Your microphone was disconnected. Switching to the system default.':
    'Seu microfone foi desconectado. Mudando para o padrão do sistema.',

  // ---- stage and shared screens
  'They join with this code.': 'Eles entram com este código.',
  'No one is sharing yet. Press Share screen to show your game.':
    'Ninguém está compartilhando ainda. Clique em Compartilhar tela para mostrar seu jogo.',
  'LIVE': 'AO VIVO',
  'No sound': 'Sem som',
  '{name} isn’t sharing sound': '{name} não está compartilhando o som',
  'Stream volume': 'Volume da transmissão',
  '{name}’s stream volume': 'Volume da transmissão de {name}',
  'Mute stream sound': 'Silenciar o som da transmissão',
  'Unmute stream sound': 'Ativar o som da transmissão',
  'Stop': 'Parar',
  'Stats': 'Dados',
  'Show what each friend is getting from you': 'Mostrar o que cada amigo está recebendo de você',
  'Show stream numbers: resolution, frame rate, bitrate, delay':
    'Mostrar os dados da transmissão: resolução, fps, taxa de bits e atraso',
  'Full screen': 'Tela cheia',
  'Cinema': 'Cinema',
  'Cinema mode: only this screen, as big as the window (Ctrl+Shift+C)': 'Modo cinema: só esta tela, do tamanho da janela (Ctrl+Shift+C)',
  'Leave cinema mode (Esc or Ctrl+Shift+C)': 'Sair do modo cinema (Esc ou Ctrl+Shift+C)',
  'Cinema mode needs a friend’s screen to watch.': 'O modo cinema precisa da tela de um amigo para assistir.',
  'Cinema mode. Press Esc or Ctrl+Shift+C to leave.': 'Modo cinema. Aperte Esc ou Ctrl+Shift+C para sair.',
  'Exit full screen': 'Sair da tela cheia',
  'Couldn’t go full screen.': 'Não foi possível ir para a tela cheia.',
  'Hide my preview (keeps sharing)': 'Esconder minha prévia (continua compartilhando)',
  'Close this screen': 'Fechar esta tela',
  'Preview hidden. You’re still sharing.': 'Prévia escondida. Você continua compartilhando.',
  'no sound': 'sem som',
  'sound': 'som',
  'sound: {app} only': 'som: apenas {app}',
  'this app': 'este programa',
  'sound: whole computer except GameShare': 'som: computador todo, menos o GameShare',
  'sound: unknown (they need to update GameShare)': 'som: desconhecido (precisa atualizar o GameShare)',
  'The shared app’s sound stopped.': 'O som do programa compartilhado parou.',
  'GameShare hit a problem and restarted. You’re back in the room.':
    'O GameShare teve um problema e reiniciou. Você está de volta na sala.',

  // ---- stats on screens
  'not connected ({state})': 'não conectado ({state})',
  'waiting for video…': 'esperando o vídeo…',
  '{n} freeze': '{n} travada',
  '{n} freezes': '{n} travadas',
  '{n} ms buffer': 'buffer de {n} ms',
  'buffer {n} ms': 'buffer de {n} ms',
  '{n}% lost': '{n}% de perda',
  'direct': 'conexão direta',
  'via relay server': 'via servidor de retransmissão',
  'hardware decoding': 'decodificação na placa de vídeo',
  'software decoding': 'decodificação no processador',
  'hardware encoding': 'codificação na placa de vídeo',
  'software encoding': 'codificação no processador',
  'connecting…': 'conectando…',
  'paused': 'pausado',
  'paused (they minimized GameShare)': 'pausado (minimizou o GameShare)',
  'net': 'rede',
  'held back by your CPU': 'limitado pelo seu processador',
  'held back by the connection': 'limitado pela conexão',
  'held back by {why}': 'limitado por {why}',
  'video': 'vídeo',
  'Video mode': 'Modo Vídeo',
  'Game mode': 'Modo Jogo',
  'aims for {n} ms': 'meta de {n} ms',
  'sound {n} kbps': 'som {n} kbps',
  'sound in sync': 'som em sincronia',
  'sound {n} ms late': 'som {n} ms atrasado',
  'sound {n} ms early': 'som {n} ms adiantado',
  'source {n} fps': 'origem {n} fps',
  'still: keeping it sharp': 'parado: mantendo a nitidez',
  'sound waits {n} ms': 'som espera {n} ms',
  'Close': 'Fechar',
  'Your shared window looks black': 'A janela que você está compartilhando parece preta',
  'Streaming sites like Netflix, Prime Video and Disney+ protect their video, so a screen capture gets a black picture. What usually brings it back: in that browser’s settings, turn off “Use graphics acceleration when available” (hardware acceleration) and restart the browser. GameShare doesn’t get around the protection: if it stays black, that site can’t be shared.':
    'Sites de streaming como Netflix, Prime Video e Disney+ protegem o vídeo, então a captura de tela recebe uma imagem preta. O que costuma resolver: nas configurações desse navegador, desative “Usar aceleração gráfica quando disponível” (aceleração de hardware) e reinicie o navegador. O GameShare não contorna a proteção: se continuar preto, esse site não pode ser compartilhado.',
  'Nobody is watching yet': 'Ninguém está assistindo ainda',

  // ---- share picker
  'What do you want to share?': 'O que você quer compartilhar?',
  'Windows': 'Janelas',
  'Screens': 'Telas',
  'Finding windows…': 'Procurando janelas…',
  'No windows found. Try the Screens tab.': 'Nenhuma janela encontrada. Tente a aba Telas.',
  'No screens found. On a Mac, allow Screen Recording for GameShare and restart it.':
    'Nenhuma tela encontrada. No Mac, permita a Gravação de Tela para o GameShare e abra-o de novo.',
  'Share this app’s sound': 'Compartilhar o som deste programa',
  'Only the window you pick. Never your call.': 'Só da janela escolhida. Nunca a sua chamada.',
  'Share computer sound': 'Compartilhar o som do computador',
  'Everything except GameShare, so friends never hear themselves.':
    'Tudo, menos o GameShare, para os amigos nunca ouvirem a própria voz.',
  'Look for windows again': 'Procurar janelas de novo',
  'Refresh': 'Atualizar',
  'Cancel': 'Cancelar',
  'Share (Enter)': 'Compartilhar (Enter)',
  'Share': 'Compartilhar',
  'Couldn’t capture that. On a Mac, allow GameShare under System Settings › Privacy › Screen Recording.':
    'Não foi possível capturar isso. No Mac, permita o GameShare em Ajustes do Sistema › Privacidade › Gravação de Tela.',
  'Sharing without sound: {why}.': 'Compartilhando sem som: {why}.',
  'it only works on Windows': 'só funciona no Windows',
  'it needs Windows 10 version 2004 or newer': 'precisa do Windows 10 versão 2004 ou mais novo',
  'that window was closed': 'essa janela foi fechada',
  'sound capture took too long to start': 'a captura de som demorou demais para começar',
  'the sound capture stopped': 'a captura de som parou',

  // ---- in-game overlay
  'You’re muted': 'Você está silenciado',
  // ---- updates
  'Not now': 'Agora não',
  'Skip this version': 'Pular esta versão',
  'Check for updates': 'Procurar atualizações',
  'Looks for a new GameShare when it opens. Nothing is installed unless you say so.': 'Procura um GameShare novo ao abrir. Nada é instalado sem você mandar.',
  'Updates': 'Atualizações',
  'Check now': 'Verificar agora',
  'Checking…': 'Verificando…',
  'GameShare {v} is available': 'GameShare {v} disponível',
  'Update': 'Atualizar',
  'Downloading GameShare {v}… {p}%': 'Baixando o GameShare {v}… {p}%',
  'GameShare {v} is ready': 'GameShare {v} pronto',
  'Restart now': 'Reiniciar agora',
  'Later': 'Depois',
  'It starts the next time you open GameShare.': 'Ele entra na próxima vez que você abrir o GameShare.',
  'This version needs a fresh install. Download it and run the installer.': 'Esta versão precisa ser instalada de novo. Baixe e rode o instalador.',
  'Download': 'Baixar',
  'GameShare {v} needs a fresh install.': 'O GameShare {v} precisa ser instalado de novo.',
  'Downloading… {p}%': 'Baixando… {p}%',
  'GameShare {v} starts the next time you open GameShare.': 'O GameShare {v} entra na próxima vez que você abrir o GameShare.',
  'You have the latest version.': 'Você está na versão mais recente.',
  'Couldn’t check for updates ({error}).': 'Não deu para procurar atualizações ({error}).',
  'Updates aren’t set up in this copy of GameShare.': 'As atualizações não estão configuradas nesta cópia do GameShare.',
  'Version {v}': 'Versão {v}',
  'Installed version: {v}.': 'Versão do instalador: {v}.',
  'Back to {v}': 'Voltar para a {v}',
  'Goes back to {v} the next time you open GameShare.': 'Volta para a {v} na próxima vez que você abrir o GameShare.',
  'Update failed: {error}': 'A atualização falhou: {error}'
};

const LANGS = { pt: PT };
// Shown in the language menus, each in its own language.
const LANG_NAMES = { en: 'English', pt: 'Português (Brasil)' };

const fillIn = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

let currentLang = 'en';

// The translated text for English `s`, with {slots} filled from `vars`.
function tr(s, vars) {
  const d = LANGS[currentLang];
  return fillIn(d && Object.prototype.hasOwnProperty.call(d, s) ? d[s] : s, vars);
}
// One or many: trn(3, '{n} friend', '{n} friends') -> "3 friends".
function trn(n, one, other, vars) {
  return tr(n === 1 ? one : other, { n, ...vars });
}
// Always English (the diagnostics report).
function trEn(s, vars) {
  return fillIn(s, vars);
}

const i18n = (() => {
  // Text written in index.html: every text node and these attributes whose
  // English is in the dictionary. Remembered so a language switch can redo
  // them, unless the app has changed that text since (it redoes those itself).
  const ATTRS = ['title', 'aria-label', 'placeholder', 'data-label'];
  const known = new Set(Object.keys(PT));
  let page = null;

  function collect() {
    page = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const raw = n.nodeValue;
        const en = raw.trim();
        if (!known.has(en)) continue;
        const at = raw.indexOf(en);
        page.push({ node: n, en, lead: raw.slice(0, at), trail: raw.slice(at + en.length), written: raw });
      } else if (n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
        for (const attr of ATTRS) {
          const en = n.getAttribute(attr);
          if (en && known.has(en)) page.push({ node: n, attr, en, written: en });
        }
      }
    }
  }

  function translatePage() {
    if (!page) collect();
    for (const r of page) {
      const now = r.attr ? r.node.getAttribute(r.attr) : r.node.nodeValue;
      if (now !== r.written) continue; // the app changed it since
      const next = r.attr ? tr(r.en) : r.lead + tr(r.en) + r.trail;
      if (r.attr) r.node.setAttribute(r.attr, next); else r.node.nodeValue = next;
      r.written = next;
    }
  }

  // 'auto' follows the computer's language.
  function resolve(pref) {
    if (pref === 'en' || LANGS[pref]) return pref;
    const sys = [...(navigator.languages || []), navigator.language || ''];
    for (const l of sys) {
      const base = String(l).toLowerCase().split('-')[0];
      if (base === 'en') return 'en';
      if (LANGS[base]) return base;
    }
    return 'en';
  }

  function setLang(pref) {
    currentLang = resolve(pref);
    document.documentElement.lang = currentLang === 'pt' ? 'pt-BR' : currentLang;
    translatePage();
  }

  // Before the app's own code runs: the saved choice, or the computer's language.
  let saved = 'auto';
  try { saved = (JSON.parse(localStorage.getItem('gs-prefs') || '{}').lang) || 'auto'; } catch { /* ignore */ }
  setLang(saved);

  return { setLang, current: () => currentLang };
})();
