const ADMIN_TITLE = "YourBar Community Moderation";

function adminStyles(): string {
  return `
    :root { color-scheme: light; --ink:#17221c; --muted:#68746d; --line:#dfe6e1; --paper:#fff; --wash:#f4f7f5; --brand:#215c3d; --brand-dark:#153e2a; --brand-soft:#e7f2eb; --danger:#a43d3d; --danger-soft:#fbecec; --amber:#9a6516; --shadow:0 18px 50px rgba(24,50,35,.1); }
    * { box-sizing:border-box; }
    body { margin:0; min-width:320px; background:var(--wash); color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,textarea { font:inherit; }
    button { cursor:pointer; }
    button:disabled { cursor:not-allowed; opacity:.55; }
    .shell { min-height:100vh; display:grid; grid-template-columns:252px minmax(0,1fr); }
    .sidebar { position:sticky; top:0; height:100vh; padding:28px 22px; background:var(--brand-dark); color:#fff; display:flex; flex-direction:column; }
    .brand { display:flex; gap:12px; align-items:center; margin-bottom:42px; }
    .brand-mark { width:42px; height:42px; border-radius:13px; display:grid; place-items:center; background:#fff; color:var(--brand-dark); font-size:23px; box-shadow:0 8px 18px rgba(0,0,0,.18); }
    .brand strong { display:block; font-size:18px; letter-spacing:-.02em; }
    .brand span { display:block; margin-top:2px; color:#b9d0c2; font-size:12px; }
    .nav-label { margin:0 10px 10px; color:#8fb09b; font-size:10px; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    .nav { display:grid; gap:7px; }
    .nav button { width:100%; border:0; border-radius:11px; padding:12px 13px; color:#d9e6de; background:transparent; display:flex; align-items:center; justify-content:space-between; text-align:left; }
    .nav button:hover { background:rgba(255,255,255,.07); }
    .nav button.active { color:#fff; background:rgba(255,255,255,.13); font-weight:750; }
    .count { min-width:28px; padding:3px 8px; border-radius:999px; background:rgba(255,255,255,.11); text-align:center; font-size:12px; }
    .nav button.active .count { background:#fff; color:var(--brand-dark); }
    .sidebar-foot { margin-top:auto; padding:14px; border:1px solid rgba(255,255,255,.12); border-radius:12px; color:#b9d0c2; font-size:12px; line-height:1.55; }
    main { min-width:0; padding:34px clamp(22px,4vw,58px) 60px; }
    .topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; margin-bottom:26px; }
    .eyebrow { margin:0 0 7px; color:var(--brand); font-size:11px; font-weight:850; letter-spacing:.13em; text-transform:uppercase; }
    h1 { margin:0; font-family:Georgia,"Times New Roman",serif; font-size:clamp(30px,4vw,44px); line-height:1.05; letter-spacing:-.035em; }
    .subtitle { margin:10px 0 0; color:var(--muted); font-size:14px; }
    .refresh { border:1px solid var(--line); border-radius:10px; padding:10px 14px; background:var(--paper); color:var(--ink); font-weight:700; box-shadow:0 2px 7px rgba(20,45,30,.04); }
    .refresh:hover { border-color:#b8c8be; background:#fbfdfb; }
    .status { min-height:20px; margin-bottom:16px; color:var(--muted); font-size:13px; }
    .status.error { color:var(--danger); }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(285px,1fr)); gap:18px; }
    .card { min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:17px; background:var(--paper); box-shadow:0 5px 18px rgba(25,55,37,.045); transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease; }
    .card:hover { transform:translateY(-2px); border-color:#c6d4cb; box-shadow:0 12px 30px rgba(25,55,37,.09); }
    .card-image { position:relative; aspect-ratio:16/9; background:linear-gradient(145deg,#dce9e0,#eef4f0); overflow:hidden; display:grid; place-items:center; color:#6f8778; font-size:34px; }
    .card-image img { width:100%; height:100%; object-fit:cover; }
    .badge { position:absolute; top:12px; left:12px; padding:5px 9px; border-radius:999px; background:rgba(255,255,255,.92); color:var(--brand-dark); font-size:10px; font-weight:850; letter-spacing:.08em; text-transform:uppercase; backdrop-filter:blur(8px); }
    .card-body { padding:18px; }
    .card h2 { margin:0 0 7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:Georgia,"Times New Roman",serif; font-size:23px; letter-spacing:-.025em; }
    .author { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:12px; }
    .meta { margin:17px 0; padding:13px 0; border-top:1px solid #edf1ee; border-bottom:1px solid #edf1ee; display:flex; gap:8px; flex-wrap:wrap; color:#526158; font-size:11px; }
    .meta span { padding:5px 8px; border-radius:7px; background:#f3f6f4; }
    .review { width:100%; border:0; border-radius:10px; padding:11px 14px; background:var(--brand); color:#fff; font-weight:800; }
    .review:hover { background:var(--brand-dark); }
    .empty,.loading { grid-column:1/-1; min-height:300px; border:1px dashed #cbd7cf; border-radius:17px; display:grid; place-items:center; padding:34px; text-align:center; color:var(--muted); background:rgba(255,255,255,.55); }
    .empty p { max-width:680px; margin:8px auto 0; line-height:1.6; }
    .empty code { padding:2px 5px; border-radius:5px; background:#eef3f0; color:var(--brand-dark); font-size:.92em; }
    .empty strong { display:block; margin-bottom:7px; color:var(--ink); font-family:Georgia,"Times New Roman",serif; font-size:24px; }
    .pager { display:flex; justify-content:center; margin-top:24px; }
    .pager button { border:1px solid var(--line); border-radius:10px; padding:10px 18px; background:var(--paper); color:var(--ink); font-weight:750; }
    dialog { width:min(980px,calc(100% - 28px)); max-height:calc(100vh - 28px); padding:0; border:0; border-radius:20px; background:var(--paper); box-shadow:var(--shadow); }
    dialog::backdrop { background:rgba(10,25,16,.66); backdrop-filter:blur(4px); }
    .dialog-head { position:sticky; top:0; z-index:2; padding:18px 22px; border-bottom:1px solid var(--line); background:rgba(255,255,255,.95); display:flex; align-items:center; justify-content:space-between; gap:16px; }
    .dialog-head strong { font-family:Georgia,"Times New Roman",serif; font-size:22px; }
    .close { width:36px; height:36px; border:1px solid var(--line); border-radius:50%; background:#fff; color:var(--ink); font-size:19px; }
    .detail { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(280px,.8fr); }
    .detail-main { min-width:0; padding:25px; border-right:1px solid var(--line); }
    .detail-side { padding:25px; background:#fafcfb; }
    .hero { position:relative; width:100%; height:clamp(230px,42vw,420px); margin-bottom:24px; border-radius:14px; overflow:hidden; background:linear-gradient(145deg,#dce9e0,#eef4f0); display:grid; place-items:center; color:#6f8778; font-size:48px; }
    .hero img,.ingredient-image img { position:absolute; inset:0; display:block; width:100%; height:100%; max-width:100%; max-height:100%; object-fit:contain; object-position:center; }
    .ingredient-image img { padding:3px; }
    .detail h2 { margin:0 0 8px; font-family:Georgia,"Times New Roman",serif; font-size:34px; line-height:1.08; }
    .description { margin:0; color:var(--muted); line-height:1.65; }
    .description strong,.ingredient strong,.instructions strong { color:inherit; font-weight:800; }
    .description em,.ingredient em,.instructions em { color:inherit; font-style:italic; }
    .section { margin-top:27px; }
    .section h3 { margin:0 0 12px; font-size:12px; letter-spacing:.11em; text-transform:uppercase; }
    .ingredient { padding:11px 0; border-bottom:1px solid #edf1ee; display:flex; align-items:center; justify-content:space-between; gap:18px; }
    .ingredient:last-child { border-bottom:0; }
    .ingredient-content { min-width:0; flex:1; display:flex; align-items:center; gap:12px; }
    .ingredient-image { position:relative; width:52px; height:52px; flex:none; overflow:hidden; border:1px solid var(--line); border-radius:10px; background:linear-gradient(145deg,#eef4f0,#f8faf9); display:grid; place-items:center; color:#6f8778; font-size:21px; }
    .ingredient-info { min-width:0; }
    .ingredient-name { font-weight:700; }
    .ingredient small { display:block; margin-top:3px; color:var(--muted); }
    .amount { flex:none; color:var(--brand); font-weight:800; }
    .instructions { margin:0; padding-left:20px; color:#46534b; line-height:1.7; }
    .instructions li + li { margin-top:8px; }
    .facts { display:grid; gap:13px; }
    .fact { padding-bottom:12px; border-bottom:1px solid var(--line); }
    .fact span { display:block; margin-bottom:4px; color:var(--muted); font-size:10px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; }
    .fact strong { word-break:break-word; font-size:13px; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; }
    .tag { padding:5px 8px; border-radius:999px; background:var(--brand-soft); color:var(--brand); font-size:11px; font-weight:750; }
    label { display:block; margin:24px 0 8px; font-size:12px; font-weight:800; }
    textarea { width:100%; min-height:94px; resize:vertical; padding:11px 12px; border:1px solid #cbd6cf; border-radius:10px; background:#fff; color:var(--ink); line-height:1.5; }
    textarea:focus { outline:3px solid rgba(33,92,61,.12); border-color:var(--brand); }
    .reason-wrap[hidden] { display:none; }
    .actions { position:sticky; bottom:0; margin:24px -25px -25px; padding:17px 25px; border-top:1px solid var(--line); background:rgba(250,252,251,.97); display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .actions button { border:0; border-radius:10px; padding:12px 14px; font-weight:850; }
    .reject { background:var(--danger-soft); color:var(--danger); }
    .approve { background:var(--brand); color:#fff; }
    .confirm-reject { background:var(--danger); color:#fff; grid-column:1/-1; }
    .toast { position:fixed; right:24px; bottom:24px; z-index:20; max-width:380px; padding:13px 16px; border-radius:11px; background:var(--brand-dark); color:#fff; box-shadow:var(--shadow); font-size:13px; transform:translateY(20px); opacity:0; pointer-events:none; transition:.2s ease; }
    .toast.show { transform:none; opacity:1; }
    .toast.error { background:#7b2d2d; }
    @media (max-width:780px) { .shell{display:block}.sidebar{position:static;height:auto;padding:18px}.brand{margin-bottom:18px}.nav-label,.sidebar-foot{display:none}.nav{grid-template-columns:repeat(3,1fr)}.nav button{padding:10px 8px;font-size:12px}.nav button span:first-child{overflow:hidden;text-overflow:ellipsis}.count{display:none}main{padding:24px 16px 45px}.topbar{align-items:center}.subtitle{display:none}.detail{display:block}.detail-main{border-right:0;border-bottom:1px solid var(--line)}.dialog-head{padding:15px 17px}.detail-main,.detail-side{padding:18px}.actions{margin:22px -18px -18px;padding:15px 18px}.grid{grid-template-columns:1fr}}`;
}

function adminScript(): string {
  return `
    const config=window.__YOURBAR_ADMIN_CONFIG__||{};
    const state={status:'pending',items:[],nextCursor:null,loading:false,selected:null};
    const grid=document.querySelector('#grid'); const statusLine=document.querySelector('#status-line'); const dialog=document.querySelector('#review-dialog');
    const escapeText=(value)=>value==null?'':String(value);
    const date=(value)=>value?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
    const recipeMethod=(r)=>r.methodName||(typeof r.method==='object'&&!Array.isArray(r.method)?r.method.name:Array.isArray(r.method)?r.method.join(', '):r.method)||'Not specified';
    const glass=(r)=>r.glasswareName||r.glassware||'Not specified';
    const tagName=(tag)=>typeof tag==='string'?tag:tag.name;
    function node(tag,attrs={},children=[]){const el=document.createElement(tag);for(const [key,value] of Object.entries(attrs)){if(key==='class')el.className=value;else if(key==='text')el.textContent=escapeText(value);else if(key.startsWith('on'))el.addEventListener(key.slice(2),value);else if(value!=null)el.setAttribute(key,String(value));}for(const child of [].concat(children))if(child)el.append(child);return el;}
    function inlineMarkup(value){const fragment=document.createDocumentFragment();const text=escapeText(value);const pattern=/\\*\\*([^*\\n]+)\\*\\*|\\*([^*\\n]+)\\*/g;let offset=0;for(const match of text.matchAll(pattern)){if(match.index>offset)fragment.append(document.createTextNode(text.slice(offset,match.index)));fragment.append(node(match[1]!==undefined?'strong':'em',{text:match[1]??match[2]}));offset=match.index+match[0].length;}if(offset<text.length)fragment.append(document.createTextNode(text.slice(offset)));return fragment;}
    function formattedNode(tag,attrs,value){return node(tag,attrs,[inlineMarkup(value)]);}
    function imageBox(recipe,className){const box=node('div',{class:className});if(recipe.imageUrl){const image=node('img',{src:recipe.imageUrl,alt:recipe.name||'',loading:'lazy',referrerpolicy:'no-referrer'});image.addEventListener('error',()=>{box.replaceChildren(node('span',{text:'🍸'}));});box.append(image);}else box.append(node('span',{text:'🍸'}));return box;}
    function setStatus(message,error=false){statusLine.textContent=message;statusLine.className='status'+(error?' error':'');}
    function toast(message,error=false){const el=document.querySelector('#toast');el.textContent=message;el.className='toast show'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',3200);}
    function emptyState(title,message){const empty=node('div',{class:'empty'});empty.append(node('div',{},[node('strong',{text:title}),node('p',{text:message})]));return empty;}
    function authHelp(message){const empty=node('div',{class:'empty'});empty.append(node('div',{},[node('strong',{text:'Admin API is not authenticated'}),node('p',{text:message+' Protect /admin, /admin/*, and /api/admin/community/* with the same Cloudflare Access application, then reopen /admin after signing in.'}),node('p',{},[document.createTextNode('For local preview only, run '),node('code',{text:'.dev.vars.staging'}),document.createTextNode(' with AUTH_TEST_MODE=true, apply the local D1 migration, and run the staging environment locally.')])]));return empty;}
    function render(){grid.replaceChildren();if(state.loading&&!state.items.length){grid.append(node('div',{class:'loading',text:'Loading moderation queue…'}));return;}if(!state.items.length){grid.append(emptyState(state.status==='pending'?'Queue is clear':'Nothing here yet',state.status==='pending'?'There are no recipes waiting for review.':'No submissions have this status.'));return;}for(const item of state.items){const recipe=item.recipe||{};const media=imageBox(recipe,'card-image');media.append(node('span',{class:'badge',text:item.status}));const body=node('div',{class:'card-body'});body.append(node('h2',{text:recipe.name||'Untitled recipe'}),node('div',{class:'author',text:item.googleLogin||'Unknown author'}));const meta=node('div',{class:'meta'},[node('span',{text:(recipe.ingredients?.length||0)+' ingredients'}),node('span',{text:recipeMethod(recipe)}),node('span',{text:date(item.createdAt)})]);const review=node('button',{class:'review',type:'button',text:'Review recipe',onclick:()=>openSubmission(item.id)});body.append(meta,review);grid.append(node('article',{class:'card'},[media,body]));}}
    async function request(url,options={}){const headers={...(config.testAdminHeader?{'X-Test-Admin':'true','X-Test-User-Id':'admin-local','X-Test-User-Email':'admin@example.com'}:{}),...(options.headers||{})};const response=await fetch(url,{credentials:'same-origin',...options,headers});const type=response.headers.get('content-type')||'';const body=type.includes('application/json')?await response.json():null;if(!response.ok){const error=new Error(body?.error?.message||('Request failed ('+response.status+')'));error.status=response.status;error.code=body?.error?.code;throw error;}return body;}
    async function load({append=false,cursor=null}={}){if(state.loading)return;state.loading=true;if(!append){state.items=[];state.nextCursor=null;}render();setStatus('Loading '+state.status+' submissions…');try{const suffix=cursor?'&cursor='+encodeURIComponent(cursor):'';const data=await request('/api/admin/community/submissions?status='+state.status+'&limit=24'+suffix);state.items=append?state.items.concat(data.items):data.items;state.nextCursor=data.nextCursor;setStatus(state.items.length+' submission'+(state.items.length===1?'':'s'));render();document.querySelector('#load-more').hidden=!state.nextCursor;updateCounts();}catch(error){setStatus(error.message,true);grid.replaceChildren(error.status===401?authHelp(error.message):emptyState('Could not load submissions',error.message));}finally{state.loading=false;}}
    async function updateCounts(){for(const status of ['pending','approved','rejected']){try{const data=await request('/api/admin/community/submissions?status='+status+'&limit=50');document.querySelector('[data-count="'+status+'"]').textContent=data.items.length+(data.nextCursor?'+':'');}catch{document.querySelector('[data-count="'+status+'"]').textContent='—';}}}
    function fact(label,value){return node('div',{class:'fact'},[node('span',{text:label}),node('strong',{text:value||'—'})]);}
    function instructionItems(value){const values=Array.isArray(value)?value:String(value||'').split(/\\r?\\n/).filter(Boolean);return values.length?values:['No instructions provided'];}
    async function openSubmission(id){dialog.showModal();document.querySelector('#dialog-content').replaceChildren(node('div',{class:'loading',text:'Loading recipe…'}));try{state.selected=await request('/api/admin/community/submissions/'+encodeURIComponent(id));renderDetail(state.selected);}catch(error){dialog.close();toast(error.message,true);}}
    function renderDetail(item){const r=item.recipe||{};document.querySelector('#dialog-title').textContent=r.name||'Recipe review';const main=node('div',{class:'detail-main'});main.append(imageBox(r,'hero'),node('h2',{text:r.name||'Untitled recipe'}),formattedNode('p',{class:'description'},r.description||'No description provided.'));const ingredients=node('div',{class:'section'},[node('h3',{text:'Ingredients'})]);for(const ingredient of r.ingredients||[]){const details=ingredient.note||ingredient.description;const info=node('div',{class:'ingredient-info'},[node('div',{class:'ingredient-name',text:ingredient.name}),details?formattedNode('small',{},details):null]);const content=node('div',{class:'ingredient-content'},[imageBox(ingredient,'ingredient-image'),info]);const amount=[ingredient.amount,ingredient.unitName||ingredient.unit].filter(v=>v!==undefined&&v!=='').join(' ');ingredients.append(node('div',{class:'ingredient'},[content,node('div',{class:'amount',text:amount||'—'})]));}main.append(ingredients);const steps=node('ol',{class:'instructions'});for(const step of instructionItems(r.instructions))steps.append(formattedNode('li',{},step));main.append(node('div',{class:'section'},[node('h3',{text:'Instructions'}),steps]));if(r.garnish)main.append(node('div',{class:'section'},[node('h3',{text:'Garnish'}),formattedNode('p',{class:'description'},r.garnish)]));
      const side=node('aside',{class:'detail-side'});const facts=node('div',{class:'facts'},[fact('Author',item.googleLogin),fact('Submitted',date(item.createdAt)),fact('Status',item.status),fact('Method',recipeMethod(r)),fact('Glassware',glass(r)),fact('Servings',r.servings),fact('Checksum',item.recipeChecksum)]);side.append(facts);const tags=(r.tags||[]).map(tagName).filter(Boolean);if(tags.length)side.append(node('div',{class:'section'},[node('h3',{text:'Tags'}),node('div',{class:'tags'},tags.map(tag=>node('span',{class:'tag',text:tag})))]));if(item.reviewedAt)side.append(node('div',{class:'section'},[node('h3',{text:'Review record'}),fact('Reviewed',date(item.reviewedAt)),fact('Reviewed by',item.reviewedBy),item.rejectionReason?fact('Rejection reason',item.rejectionReason):null]));
      if(item.status==='pending'){side.append(node('label',{for:'moderator-notes',text:'Moderator notes'}),node('textarea',{id:'moderator-notes',maxlength:'2000',placeholder:'Optional internal context…'}));const reason=node('div',{class:'reason-wrap',id:'reason-wrap',hidden:''},[node('label',{for:'rejection-reason',text:'Reason for rejection'}),node('textarea',{id:'rejection-reason',maxlength:'2000',placeholder:'Explain what should be corrected…'})]);side.append(reason);const actions=node('div',{class:'actions'},[node('button',{class:'reject',type:'button',text:'Reject',onclick:showReject}),node('button',{class:'approve',type:'button',text:'Approve',onclick:()=>moderate('approve')})]);side.append(actions);}
      document.querySelector('#dialog-content').replaceChildren(node('div',{class:'detail'},[main,side]));}
    function showReject(){const wrap=document.querySelector('#reason-wrap');wrap.hidden=false;const actions=document.querySelector('.actions');actions.replaceChildren(node('button',{class:'confirm-reject',type:'button',text:'Confirm rejection',onclick:()=>moderate('reject')}),node('button',{class:'approve',type:'button',text:'Cancel',onclick:()=>renderDetail(state.selected)}));document.querySelector('#rejection-reason').focus();}
    async function moderate(action){const notes=document.querySelector('#moderator-notes')?.value.trim()||undefined;const reason=document.querySelector('#rejection-reason')?.value.trim()||undefined;if(action==='reject'&&!reason){toast('Please provide a rejection reason.',true);document.querySelector('#rejection-reason')?.focus();return;}for(const button of document.querySelectorAll('.actions button'))button.disabled=true;try{await request('/api/admin/community/submissions/'+encodeURIComponent(state.selected.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,moderatorNotes:notes,rejectionReason:reason})});dialog.close();toast(action==='approve'?'Recipe approved and published.':'Recipe rejected.');await load();}catch(error){toast(error.message,true);for(const button of document.querySelectorAll('.actions button'))button.disabled=false;}}
    document.querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>{state.status=button.dataset.status;document.querySelectorAll('[data-status]').forEach(item=>item.classList.toggle('active',item===button));document.querySelector('#page-title').textContent=button.dataset.label;load();}));
    document.querySelector('#refresh').addEventListener('click',()=>load());document.querySelector('#load-more').addEventListener('click',()=>load({append:true,cursor:state.nextCursor}));document.querySelector('#dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});load();`;
}

export function adminPageResponse(options: { testAdminHeader?: boolean } = {}): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const testAdminHeader = options.testAdminHeader === true;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${ADMIN_TITLE}</title><style nonce="${nonce}">${adminStyles()}</style></head>
<body><div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark" aria-hidden="true">🍸</div><div><strong>YourBar</strong><span>Community moderation</span></div></div><p class="nav-label">Submissions</p><nav class="nav" aria-label="Submission status"><button class="active" data-status="pending" data-label="Review queue"><span>Review queue</span><span class="count" data-count="pending">—</span></button><button data-status="approved" data-label="Approved recipes"><span>Approved</span><span class="count" data-count="approved">—</span></button><button data-status="rejected" data-label="Rejected recipes"><span>Rejected</span><span class="count" data-count="rejected">—</span></button></nav><div class="sidebar-foot">Protected moderation workspace.<br>Administrator access is verified by Cloudflare Access.</div></aside>
<main><header class="topbar"><div><p class="eyebrow">Community recipes</p><h1 id="page-title">Review queue</h1><p class="subtitle">Review community submissions before they appear in YourBar.</p></div><button class="refresh" id="refresh" type="button">↻ Refresh</button></header><div class="status" id="status-line" aria-live="polite"></div><section class="grid" id="grid" aria-label="Recipe submissions"></section><div class="pager"><button id="load-more" type="button" hidden>Load more</button></div></main></div>
<dialog id="review-dialog" aria-labelledby="dialog-title"><div class="dialog-head"><strong id="dialog-title">Recipe review</strong><button class="close" id="dialog-close" type="button" aria-label="Close">×</button></div><div id="dialog-content"></div></dialog><div class="toast" id="toast" role="status" aria-live="polite"></div><script nonce="${nonce}">window.__YOURBAR_ADMIN_CONFIG__={testAdminHeader:${testAdminHeader ? "true" : "false"}};${adminScript()}</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
