"""Bind a job to its own message when a completed video conversation is reused."""
import hashlib
import re
from task_pages import read_state, remember_page, conversation_url

ROW_SCRIPT = '''() => [...document.querySelectorAll('[data-message-role]')]
 .filter(e => ['user','assistant'].includes(e.getAttribute('data-message-role')) && e.querySelector('[data-testid="message_content"]'))
 .map(e => {
   const content=e.querySelector('[data-testid="message_content"]');
   return {id:content.getAttribute('data-message-id') || e.getAttribute('data-message-id') || content.closest('[data-message-id]')?.getAttribute('data-message-id') || '',
     role:e.getAttribute('data-message-role'),text:content.innerText,images:e.querySelectorAll('img').length,
     cards:e.querySelectorAll('[class*="block-video-"]').length,hasVideo:Boolean(e.querySelector('video[src]'))};
 })'''

def read_rows(page):
    return page.evaluate(ROW_SCRIPT)

def stable_id(value):
    return isinstance(value,str) and bool(re.fullmatch(r'[A-Za-z0-9_-]{1,160}',value)) and not value.startswith(('local_','draft_'))

def matches(job,text,service):
    if service=='dola':
        from dola_prompt import matches_prompt
        return matches_prompt(job,text)
    from doubao_parameters import prompt_matches
    return prompt_matches(job.get('prompt',''),text)

def confirmation(text,job):
    from doubao_parameters import is_confirmation_message
    return is_confirmation_message(text,job)

def supported(job):
    return bool(isinstance(job.get('id'),str) and job.get('profilePath'))

def bind_message(context,page,job,service):
    if not supported(job):
        return True
    state=read_state(job,service)
    rows=read_rows(page)
    existing=job.get('remoteMessageId') or state.get('remoteMessageId')
    baseline=set(state.get('baselineMessageIds',[]))
    candidates=[r for r in rows if r['role']=='user' and stable_id(r['id'])
                and ((r['id']==existing) if existing else r['id'] not in baseline and matches(job,r['text'],service))]
    if len(candidates)>1:
        raise RuntimeError('TASK_MESSAGE_AMBIGUOUS')
    if not candidates:
        return False
    row=candidates[0]
    if not matches(job,row['text'],service):
        raise RuntimeError('TASK_MESSAGE_MISMATCH')
    job['remoteMessageId']=row['id']
    remember_page(context,page,job,service,details={'remoteMessageId':row['id']})
    return True

def scoped_rows(page,job,service,rows=None):
    rows=read_rows(page) if rows is None else rows
    if not supported(job):
        return rows
    state=read_state(job,service)
    message_id=job.get('remoteMessageId') or state.get('remoteMessageId')
    if not message_id:
        baseline=set(state.get('baselineMessageIds',[]))
        candidates=[r for r in rows if r['role']=='user' and stable_id(r['id']) and r['id'] not in baseline and matches(job,r['text'],service)]
        if len(candidates)>1:
            raise RuntimeError('TASK_MESSAGE_AMBIGUOUS')
        if not candidates:
            return []
        message_id=candidates[0]['id']
    indexes=[i for i,r in enumerate(rows) if r['role']=='user' and r['id']==message_id]
    if not indexes:
        return []
    if len(indexes)!=1:
        raise RuntimeError('TASK_MESSAGE_NOT_FOUND')
    start=indexes[0]
    if not matches(job,rows[start]['text'],service):
        raise RuntimeError('TASK_MESSAGE_MISMATCH')
    # Doubao can leave the original, unacknowledged attachment-only bubble in
    # its DOM after the transport combined that picture and text into one saved
    # message. Only fold this immediately adjacent bubble when the page's guard
    # proves this exact image count was sent jointly. A real next user message
    # (including an image-only message with an ID) remains a task boundary.
    expected_images=len(job.get('referenceAssets') or [])
    if service=='doubao' and expected_images and start+1<len(rows):
        extra=rows[start+1]
        if (extra['role']=='user' and not stable_id(extra.get('id')) and not extra['text'].strip()
                and extra.get('images')==expected_images):
            joint=page.evaluate('() => window.__symphonyJointSubmission || null')
            if (joint and joint.get('accepted',0)>0 and joint.get('originalMessages',0)>1
                    and joint.get('messages')==1 and joint.get('images')==expected_images
                    and joint.get('textPresent')):
                rows=rows[:start+1]+rows[start+2:]
    end=next((i for i in range(start+1,len(rows)) if rows[i]['role']=='user' and not confirmation(rows[i]['text'],job)),len(rows))
    return rows[start:end]

def assistant_texts(page,job,service):
    if not supported(job or {}):
        return page.locator('[data-message-role="assistant"] [data-testid="message_content"]').all_text_contents()
    return [r['text'] for r in scoped_rows(page,job,service) if r['role']=='assistant']

def check_context_limit(page,job,service,texts=None,notices=None):
    if not job:
        return
    texts=assistant_texts(page,job,service) if texts is None else texts
    started=any(re.search(r'your video is ready|video will be generated|(?:generating|creating) (?:your |the )?video|生成好后会通知你|(?:正在生成视频|视频.{0,10}(?:生成中|生成好了|已生成))',text,re.I) for text in texts)
    if supported(job) and any(r.get('cards') or r.get('hasVideo') for r in scoped_rows(page,job,service) if r['role']=='assistant'):
        started=True
    if started:
        job['generationAcknowledged']=True
    notices=page.locator('[role="alert"], .semi-toast-content').all_text_contents() if notices is None else notices
    old_notices=set(read_state(job,service).get('baselineNotices',[])) if supported(job) else set()
    notices=[text for text in notices if hashlib.sha256(text.encode()).hexdigest() not in old_notices]
    limited=any(re.search(r'(?:上下文|对话|会话).{0,12}(?:过长|长度.{0,8}(?:上限|超出)|达到.{0,8}上限)|(?:conversation|context|chat).{0,25}(?:too long|length.{0,15}(?:limit|exceed))|maximum (?:conversation|context|chat) length',text,re.I) for text in texts+notices)
    if limited:
        raise RuntimeError('CONVERSATION_CONTEXT_LIMIT')

def scoped_locator(page,job,service,selector):
    if not supported(job or {}):
        return page.locator(selector)
    rows=scoped_rows(page,job,service)
    ids=[r['id'] for r in rows if r['role']=='assistant' and stable_id(r['id'])]
    token=hashlib.sha256(job['id'].encode()).hexdigest()
    page.evaluate('''({ids,token}) => {
      for(const e of document.querySelectorAll('[data-symphony-task-scope]'))e.removeAttribute('data-symphony-task-scope');
      for(const e of document.querySelectorAll('[data-message-role="assistant"]')){
        const c=e.querySelector('[data-testid="message_content"]');if(!c)continue;
        const id=c.getAttribute('data-message-id') || e.getAttribute('data-message-id') || c.closest('[data-message-id]')?.getAttribute('data-message-id');
        if(ids.includes(id))e.setAttribute('data-symphony-task-scope',token);
      }
    }''',{'ids':ids,'token':token})
    return page.locator('[data-symphony-task-scope="'+token+'"] '+selector)

def reusable_page(context,job,service,states):
    """Reuse only fully accounted-for, completed workbench video messages.

    Untracked chats, partially loaded histories and uncertain states fall back
    to a new conversation. This function never navigates or submits.
    """
    complete=[s for s in states if s.get('service')==service and s.get('finished') and s.get('remoteUrl') and stable_id(s.get('remoteMessageId'))]
    active={s.get('remoteUrl') for s in states if s.get('service')==service and s.get('submissionStarted') and not s.get('finished')}
    for page in reversed(list(context.pages)):
        try:
            url=conversation_url(page.url,service)
            known=[s for s in complete if s['remoteUrl']==url]
            if not known or url in active or not any(not s.get('reused') for s in known):
                continue
            if service=='doubao':
                if not page.locator('[data-input-engine-actionbar-render-entry-key="creation-video-generation-params-panel"]').count():
                    continue
            elif not page.locator('[data-testid="chat_input"]').get_by_role('button',name=re.compile(r'^Model')).count():
                continue
            rows=read_rows(page)
            if not rows or any(not stable_id(r['id']) for r in rows) or len({r['id'] for r in rows})!=len(rows):
                continue
            if len(rows)>40 or sum(len(r['text']) for r in rows)>40000:
                continue
            known_ids={s['remoteMessageId'] for s in known}
            users=[r for r in rows if r['role']=='user']
            prompts=[r for r in users if r['id'] in known_ids]
            if {r['id'] for r in prompts}!=known_ids:
                continue
            if any(r['id'] not in known_ids and not re.fullmatch(r'(?:生成视频：)?确认生成(?:，\d+:\d+)?',r['text'].strip()) for r in users):
                continue
            # Every prompt needs its own completed video card; an empty,
            # pending or non-video turn is insufficient evidence for reuse.
            valid=True
            for index,row in enumerate(rows):
                if row['role']!='user' or row['id'] not in known_ids:
                    continue
                end=next((i for i in range(index+1,len(rows)) if rows[i]['role']=='user' and rows[i]['id'] in known_ids),len(rows))
                if not any(r['role']=='assistant' and (r.get('cards') or r.get('hasVideo')) for r in rows[index+1:end]):
                    valid=False;break
            if valid:
                return page,url,[r['id'] for r in rows]
        except Exception:
            continue
    return None
