import urllib.request, json
req = urllib.request.Request("https://onepass.ongkharak.ac.th/api/login",
    data=json.dumps({"username":"admin","password":"1234"}).encode(),
    headers={"Content-Type":"application/json"})
try:
    res = urllib.request.urlopen(req, timeout=15)
    data = json.loads(res.read().decode())
    token = data.get("token")
    print("TOKEN:", token)
    if token:
        req2 = urllib.request.Request("https://onepass.ongkharak.ac.th/api/device/status",
            headers={"Authorization": "Bearer " + token})
        res2 = urllib.request.urlopen(req2, timeout=15)
        print("STATUS:", res2.read().decode())
except Exception as e:
    print("ERR", e)
    if hasattr(e, 'read'):
        print(e.read().decode())
