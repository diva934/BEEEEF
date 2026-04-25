
const fs = require('fs');
const file = 'C:/Users/pierr/Downloads/BEEF/index.html.html';
let html = fs.readFileSync(file, 'utf8');

// ── Replace JS emoji strings ──
html = html
  // timer text (remove clock emoji from textContent)
  .replace(/'⏱ '\+fmtTime/g, "fmtTime")
  .replace(/'⏱ '\+t\b/g, "t")
  .replace(/`⏱ \$\{/g, '`${')

  // showToast icon arg replacements
  .replace(/showToast\('⚠️'/g, "showToast('warn'")
  .replace(/showToast\('✅'/g, "showToast('ok'")
  .replace(/showToast\('❌'/g, "showToast('err'")
  .replace(/showToast\('💰'/g, "showToast('coins'")
  .replace(/showToast\('🤖'/g, "showToast('ai'")
  .replace(/showToast\('🟢'/g, "showToast('yes'")
  .replace(/showToast\('🔴'/g, "showToast('no'")

  // server/lang label text
  .replace(/st\.textContent = `⚡ \$\{region\.server\}`/g, 'st.textContent = region.server')
  .replace(/serverInfo\.textContent = \(region\?`⚡ \$\{region\.server\}`:''\)/g,
           "serverInfo.textContent = (region?region.server:'')")
  .replace(/langs\.map\(l=>l\.flag\)\.join\(''\) \+ ' Langues' : '🌍 Langues'/g,
           "langs.map(l=>l.flag).join('') + ' Langues' : 'Langues'")

  // card badge: trending
  .replace(/d\.trending\?'<div class=\\"card-trending-badge\\">🔥 TRENDING<\/div>':''/g,
           `d.trending?'<div class=\\"card-trending-badge\\"><svg class=\\"ic\\" width=\\"11\\" height=\\"11\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-trend\\"/></svg> TRENDING</div>':''`)

  // card timer
  .replace(/<div class=\\"card-timer\\">⏱ \$\{timerStr\}<\/div>/g,
           '<div class=\\"card-timer\\"><svg class=\\"ic\\" width=\\"10\\" height=\\"10\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-clock\\"/></svg> ${timerStr}</div>')

  // card AI badge
  .replace(/d\.ai\?'<div class=\\"card-ai-badge\\">🤖 AI<\/div>':''/g,
           `d.ai?'<div class=\\"card-ai-badge\\"><svg class=\\"ic\\" width=\\"10\\" height=\\"10\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-ai\\"/></svg> AI</div>':''`)

  // closed card + overlay
  .replace(/id=\\"cw\$\{d\.id\}\\">🤖 Analyse…<\/div><\/div>/g,
           'id=\\"cw${d.id}\\">Analyse IA…</div></div>')
  .replace(/id=\\"cw\$\{debate\.id\}\\">🤖 Analyse…<\/div>`/g,
           'id=\\"cw${debate.id}\\">Analyse IA…</div>`')

  // ended banner
  .replace(/'🤖 Analyse IA du vainqueur…'/g, "'Analyse IA du vainqueur…'")
  .replace(/'🏆 '\+w\+' gagne'/g, "w+' gagne'")
  .replace(/'🏆 '\+verdict\.winner\+' gagne'/g, "verdict.winner+' gagne'")
  .replace(/'🏆 '\+verdict\.winner\+' remporte le débat !'/g, "verdict.winner+' remporte le débat !'")
  .replace(/'💰 Gains crédités : \+'\+fmtBalance/g, "'Gains crédités : +'+fmtBalance")

  // AI verdict criteria label
  .replace(/>💬 Conviction</g, '>Conviction<')

  // waiting spot
  .replace(/>🎙️ Vous ·/g, '>Vous ·')

  // mute button JS
  .replace(/this\.textContent=muted\?'🔇':'🔊';/g,
           `this.innerHTML=muted?'<svg class=\\"ic\\" width=\\"16\\" height=\\"16\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-vol-off\\"/></svg>':'<svg class=\\"ic\\" width=\\"16\\" height=\\"16\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-vol\\"/></svg>';`)

  // proom mute indicator in JS
  .replace(/el\.innerHTML='🔇'/g,
           `el.innerHTML='<svg class=\\"ic\\" width=\\"14\\" height=\\"14\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-mic-off\\"/></svg>'`)
  .replace(/el\.innerHTML='🎙️'/g,
           `el.innerHTML='<svg class=\\"ic\\" width=\\"14\\" height=\\"14\\" viewBox=\\"0 0 24 24\\"><use href=\\"#ic-mic\\"/></svg>'`);

fs.writeFileSync(file, html, 'utf8');
console.log('JS emoji replaced. Lines:', html.split('\n').length);
