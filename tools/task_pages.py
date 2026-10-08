"""Keep one platform conversation and browser target bound to each video job."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlparse


def conversation_url(value, service):
    try:
        parsed = urlparse(value)
        if (service not in ('doubao', 'dola') or parsed.scheme != 'https'
                or parsed.hostname != 'www.' + service + '.com'
                or parsed.username or parsed.password or parsed.port not in (None, 443)
                or not re.fullmatch(r'/chat/[0-9]+', parsed.path)):
            raise ValueError()
        return 'https://www.' + service + '.com' + parsed.path
    except (ValueError, TypeError):
        raise RuntimeError('INVALID_REMOTE_URL') from None


def state_path(job):
    if not isinstance(job.get('id'), str) or not job.get('id') or not job.get('profilePath'):
        return None
    return Path(job['profilePath']) / '.symphony-task-pages' / (hashlib.sha256(job['id'].encode()).hexdigest() + '.json')


def read_state(job, service):
    path = state_path(job)
    if path is None or not path.exists():
        return {}
    try:
        state = json.loads(path.read_text(encoding='utf8'))
        if state.get('jobId') != job['id'] or state.get('service') != service:
            raise ValueError()
        if state.get('remoteUrl'):
            conversation_url(state['remoteUrl'], service)
        return state
    except (OSError, ValueError, AttributeError, RuntimeError):
        raise RuntimeError('TASK_PAGE_STATE_INVALID') from None


def target_id(context, page):
    session = None
    try:
        session = context.new_cdp_session(page)
        return session.send('Target.getTargetInfo')['targetInfo']['targetId']
    except Exception:
        # An unrelated tab can close between taking the page list and reading
        # its target. Do not confuse that race with losing this task's browser.
        if page.is_closed():
            return None
        raise
    finally:
        if session is not None:
            try:
                session.detach()
            except Exception:
                if not page.is_closed():
                    raise


def remember_page(context, page, job, service, remote_url=None, submitting=False, finished=False, details=None):
    if hasattr(context, 'preserve_page'):
        context.preserve_page(page)
    path = state_path(job)
    if path is None:
        return
    state = read_state(job, service)
    expected = remote_url or job.get('collectExistingUrl') or job.get('remoteUrl') or state.get('remoteUrl')
    if expected:
        expected = conversation_url(expected, service)
    if state.get('remoteUrl') and expected != state['remoteUrl']:
        raise RuntimeError('TASK_CONVERSATION_CHANGED')
    if submitting and state.get('submissionStarted'):
        raise RuntimeError('TASK_SUBMISSION_ALREADY_STARTED')
    state.update(version=1, jobId=job['id'], service=service, targetId=target_id(context, page), remoteUrl=expected,
                 submissionStarted=bool(submitting or state.get('submissionStarted')), finished=bool(finished or state.get('finished')))
    state.update(details or {})
    write_state(path,state)


def write_state(path,state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            json.dump(state, output)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def can_restart_context(job,service):
    state=read_state(job,service)
    return bool(state_path(job) and not job.get('collectExistingUrl') and not job.get('collectOnly')
                and not job.get('generationAcknowledged') and not state.get('generationAcknowledged')
                and not state.get('finished') and not state.get('contextRestarts'))


def restart_context(context,job,service,reason='CONVERSATION_CONTEXT_LIMIT'):
    if not can_restart_context(job,service):
        raise RuntimeError('CONVERSATION_CONTEXT_LIMIT')
    state=read_state(job,service)
    previous={key:state.get(key) for key in ('remoteUrl','remoteMessageId','targetId')}
    page=context.new_page()
    if hasattr(context,'preserve_page'):context.preserve_page(page)
    write_state(state_path(job),{'version':1,'jobId':job['id'],'service':service,'targetId':target_id(context,page),
        'remoteUrl':None,'remoteMessageId':None,'submissionStarted':False,'finished':False,'reused':False,
        'contextRestarts':1,'contextRestartReason':reason,'previousRejectedConversation':previous})
    for name in ['remoteUrl','remoteMessageId','reuseConversation']:
        job.pop(name,None)
    page.bring_to_front()
    return page


def find_page(context, job, service):
    """Never browse history or navigate another task's page to discover a job."""
    state = read_state(job, service)
    expected = job.get('collectExistingUrl') or job.get('remoteUrl') or state.get('remoteUrl')
    if expected:
        expected = conversation_url(expected, service)
        if state.get('remoteUrl') and state['remoteUrl'] != expected:
            raise RuntimeError('TASK_CONVERSATION_CHANGED')
    if state.get('targetId'):
        for page in context.pages:
            if target_id(context, page) == state['targetId']:
                if expected:
                    try:
                        actual = conversation_url(page.url, service)
                    except RuntimeError:
                        actual = None  # Preserve the original login/challenge page for its operator.
                    if actual and actual != expected:
                        raise RuntimeError('TASK_CONVERSATION_CHANGED')
                remember_page(context, page, job, service, expected)
                return page
    if expected:
        for page in context.pages:
            try:
                matches = conversation_url(page.url, service) == expected
            except RuntimeError:
                matches = False
            if matches:
                remember_page(context, page, job, service, expected)
                return page
        # The browser/target was lost. Reopen only the already bound conversation.
        page = context.new_page()
        remember_page(context, page, job, service, expected)
        page.goto(expected, wait_until='domcontentloaded', timeout=60000)
        return page
    if state.get('submissionStarted'):
        # A CAPTCHA can precede the durable conversation ID; never replace that
        # uncertain submission with a fresh chat after losing its browser target.
        raise RuntimeError('TASK_ORIGINAL_PAGE_LOST')
    return None


def job_page(context, job, service):
    if not job.get('collectExistingUrl') and read_state(job, service).get('submissionStarted'):
        raise RuntimeError('TASK_SUBMISSION_ALREADY_STARTED')
    page = find_page(context, job, service)
    if page is None:
        from task_messages import reusable_page
        selected = reusable_page(context, job, service, all_states(job))
        if selected:
            page,remote,baseline=selected
            remember_page(context,page,job,service,remote,details={'reused':True,'baselineMessageIds':baseline})
        else:
            page = context.new_page()
            remember_page(context, page, job, service)
    state=read_state(job,service)
    if state.get('reused'):
        job['reuseConversation']=state['remoteUrl']
        job['remoteUrl']=state['remoteUrl']
    if state.get('remoteMessageId'):
        job['remoteMessageId']=state['remoteMessageId']
    page.bring_to_front()
    return page


def assert_conversation(page, job, service):
    expected = job.get('collectExistingUrl') or job.get('remoteUrl')
    if not expected:
        return
    expected = conversation_url(expected, service)
    try:
        actual = conversation_url(page.url, service)
    except RuntimeError:
        actual = None
    if actual != expected:
        raise RuntimeError('TASK_CONVERSATION_CHANGED')


def begin_submission(context, page, job, service):
    from task_messages import read_rows, supported
    state=read_state(job,service)
    baseline=[];notices=[]
    if supported(job):
        baseline=[r['id'] for r in read_rows(page)]
        notices=[hashlib.sha256(text.encode()).hexdigest() for text in page.locator('[role="alert"], .semi-toast-content').all_text_contents()]
        if state.get('reused') and baseline!=state.get('baselineMessageIds'):
            raise RuntimeError('TASK_CONVERSATION_CHANGED')
        if state.get('reused'):
            assert_conversation(page,job,service)
    remember_page(context, page, job, service, submitting=True,details={'baselineMessageIds':baseline,'baselineNotices':notices})


def finish_page(context, page, job, service):
    # A metadata failure must not turn a successfully saved video into a failed job.
    try:
        from task_messages import bind_message
        try:
            bind_message(context,page,job,service)
        except Exception:
            pass
        remember_page(context, page, job, service, finished=True)
    except Exception:
        pass


def all_states(job):
    path = state_path(job)
    if path is None:
        return []
    states=[]
    for file in path.parent.glob('*.json'):
        try:
            value = json.loads(file.read_text(encoding='utf8'))
            if isinstance(value,dict):states.append(value)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return states

def close_finished_pages(context, current, job, service):
    states=all_states(job)
    active={s.get('targetId') for s in states if not s.get('finished')}
    finished={s.get('targetId') for s in states if s.get('finished') and s.get('service')==service and s.get('jobId')!=job['id']} - active
    for page in list(context.pages):
        try:
            if page is not current and target_id(context, page) in finished:
                page.close()
        except Exception:
            # Retiring an older, completed tab is optional housekeeping.
            pass
