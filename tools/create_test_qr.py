import urllib.request, json
req = urllib.request.Request("https://onepass.ongkharak.ac.th/api/login",
    data=json.dumps({"username":"admin","password":"1234"}).encode(),
    headers={"Content-Type":"application/json"})
res = urllib.request.urlopen(req, timeout=15)
token = json.loads(res.read().decode())["token"]

req2 = urllib.request.Request("https://onepass.ongkharak.ac.th/api/device/create-test-qr",
    data=b'{}', headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
res2 = urllib.request.urlopen(req2, timeout=15)
print(res2.read().decode())
