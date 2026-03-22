import requests
import random
import string
import time
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# ===================== CONFIG =====================
FIXED_EMAIL = ""
FIXED_GROUP_ID = ""
FORM_PAGE_URL = "https://vrfi1sk8a0.feishu.cn/share/base/form/shrcndGDz9YAOoe3xkQyrx75bdc"
SUBMIT_URL = "https://vrfi1sk8a0.feishu.cn/space/api/bitable/share/content"
SHARE_TOKEN = "shrcndGDz9YAOoe3xkQyrx75bdc"

TOTAL = 1000
WORKERS = 5
DELAY_MIN = 0.5
DELAY_MAX = 2.0

# Thread-safe counters
lock = threading.Lock()
stats = {"success": 0, "fail": 0, "done": 0}
start_time = 0

# ===================== UA POOL =====================
USER_AGENTS = [
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"', '"Windows"'),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"', '"Windows"'),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"', '"Windows"'),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"', '"Windows"'),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"', '"macOS"'),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"', '"macOS"'),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"', '"macOS"'),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"', '"Linux"'),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"', '"Linux"'),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="123", "Google Chrome";v="123"', '"Linux"'),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"', '"Windows"'),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
     '"Not/A)Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"', '"Windows"'),
]


# ===================== HELPERS =====================

def random_request_id():
    prefix = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
    suffix = ''.join(random.choices(string.digits, k=19))
    return f"{prefix}-{suffix}"


def random_logid():
    ts_hex = format(int(time.time() * 1000), 'x')
    rand_hex = ''.join(random.choices('0123456789abcdef', k=48))
    return f"02{ts_hex}{rand_hex}"[:80]


def random_text(length=None):
    if length is None:
        length = random.randint(3, 10)
    return ''.join(random.choices(string.ascii_lowercase, k=length))


def progress_bar(done, total, width=25):
    filled = int(width * done / total) if total > 0 else 0
    bar = "#" * filled + "-" * (width - filled)
    pct = done / total * 100 if total > 0 else 0
    return f"[{bar}] {pct:.1f}%"


def log(msg):
    """Thread-safe print - force flush every line"""
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


# ===================== CORE =====================

def get_fresh_session(ua, sec_ch_ua, platform):
    sess = requests.Session()
    sess.headers.update({
        'user-agent': ua,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'sec-ch-ua': sec_ch_ua,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': platform,
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
    })
    sess.get(FORM_PAGE_URL, timeout=20, allow_redirects=True)
    return sess


def do_submit(sess, ua, sec_ch_ua, platform):
    req_id = random_request_id()
    log_id = random_logid()
    csrf_token = sess.cookies.get('_csrf_token', '')
    session_val = sess.cookies.get('session', '')

    submit_headers = {
        'x-auth-token': session_val,
        'x-request-id': req_id,
        'x-csrftoken': csrf_token,
        'sec-ch-ua-platform': platform,
        'sec-ch-ua': sec_ch_ua,
        'sec-ch-ua-mobile': '?0',
        'request-id': req_id,
        'x-tt-trace': '1',
        'f-version': f"docs-3-9-{int(time.time())}",
        'x-tt-trace-id': req_id,
        'user-agent': ua,
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'x-tt-logid': log_id,
        'origin': 'https://vrfi1sk8a0.feishu.cn',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': FORM_PAGE_URL,
        'accept-encoding': 'gzip, deflate, br, zstd',
        'priority': 'u=1, i',
    }

    form_data = {
        "flduAt9xvF": {
            "type": 1,
            "value": [{"type": "text", "text": FIXED_GROUP_ID}]
        },
        "fldt2WedLv": {
            "type": 1,
            "value": [{"type": "text", "text": random_text()}]
        },
        "fldq9ZwoXn": {
            "type": 1,
            "value": [{
                "type": "url",
                "text": FIXED_EMAIL,
                "link": f"mailto:{FIXED_EMAIL}"
            }]
        },
        "fld5zX9J1B": {
            "type": 1,
            "value": [{"type": "text", "text": random_text()}]
        },
    }

    payload = {
        "shareToken": SHARE_TOKEN,
        "data": json.dumps(form_data),
        "preUploadEnable": False,
    }

    return sess.post(SUBMIT_URL, headers=submit_headers, json=payload, timeout=20)


def submit_once(index):
    """Single submission: fresh session -> GET -> pause -> POST"""
    ua, sec_ch_ua, platform = random.choice(USER_AGENTS)
    m = re.search(r'Chrome/(\d+)', ua)
    chrome_ver = m.group(1) if m else "126"
    sess = None
    try:
        sess = get_fresh_session(ua, sec_ch_ua, platform)
        time.sleep(random.uniform(0.3, 1.0))
        resp = do_submit(sess, ua, sec_ch_ua, platform)
        body = resp.json()
        code = body.get('code', -1)
        msg = body.get('msg', '')
        elapsed = time.time() - start_time

        with lock:
            stats["done"] += 1
            if code == 0:
                stats["success"] += 1
            else:
                stats["fail"] += 1
            d, s, f = stats["done"], stats["success"], stats["fail"]
            bar = progress_bar(d, TOTAL)
            if code == 0:
                log(f"  [#{index+1:4d}] OK   {bar}  success={s}  fail={f}  Chrome/{chrome_ver} {platform}  {elapsed:.0f}s")
            else:
                log(f"  [#{index+1:4d}] FAIL {bar}  success={s}  fail={f}  code={code} msg={msg}")
        return code

    except requests.exceptions.Timeout:
        with lock:
            stats["done"] += 1
            stats["fail"] += 1
            d, s, f = stats["done"], stats["success"], stats["fail"]
            bar = progress_bar(d, TOTAL)
            log(f"  [#{index+1:4d}] TOUT {bar}  success={s}  fail={f}  TIMEOUT")
        return -1

    except requests.exceptions.ConnectionError as e:
        with lock:
            stats["done"] += 1
            stats["fail"] += 1
            d, s, f = stats["done"], stats["success"], stats["fail"]
            bar = progress_bar(d, TOTAL)
            log(f"  [#{index+1:4d}] CERR {bar}  success={s}  fail={f}  {str(e)[:50]}")
        return -1

    except Exception as e:
        with lock:
            stats["done"] += 1
            stats["fail"] += 1
            d, s, f = stats["done"], stats["success"], stats["fail"]
            bar = progress_bar(d, TOTAL)
            log(f"  [#{index+1:4d}] ERR  {bar}  success={s}  fail={f}  {str(e)[:60]}")
        return -1

    finally:
        if sess:
            sess.close()


def worker(task_indices):
    """Each worker handles its share of tasks sequentially"""
    for idx in task_indices:
        submit_once(idx)
        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))


# ===================== MAIN =====================
if __name__ == "__main__":
    total = int(sys.argv[1]) if len(sys.argv) > 1 else TOTAL
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else WORKERS
    TOTAL = total

    log(f"")
    log(f"============================================================")
    log(f"  Feishu Form Auto-Submitter (Multi-threaded)")
    log(f"============================================================")
    log(f"  Target:   {FORM_PAGE_URL}")
    log(f"  Email:    {FIXED_EMAIL} (fixed)")
    log(f"  GroupID:  {FIXED_GROUP_ID} (fixed)")
    log(f"  Total:    {total}")
    log(f"  Workers:  {workers} threads")
    log(f"  Delay:    {DELAY_MIN}-{DELAY_MAX}s between each")
    log(f"============================================================")
    log(f"")

    start_time = time.time()

    # Split tasks: 1000/5 = 200 each
    task_lists = [[] for _ in range(workers)]
    for i in range(total):
        task_lists[i % workers].append(i)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(worker, tl) for tl in task_lists]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as e:
                log(f"  !!! Worker crashed: {e}")

    elapsed = time.time() - start_time
    speed = stats['done'] / elapsed if elapsed > 0 else 0

    log(f"")
    log(f"============================================================")
    log(f"  DONE")
    log(f"============================================================")
    log(f"  Time:     {elapsed:.1f}s")
    log(f"  Success:  {stats['success']}")
    log(f"  Failed:   {stats['fail']}")
    log(f"  Total:    {stats['done']}")
    log(f"  Speed:    {speed:.1f} req/s")
    log(f"============================================================")
