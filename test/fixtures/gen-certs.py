# Generates the test CA and leaf certificates used by mockstore.js. Run: python3 gen-certs.py
import datetime as dt
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

def key():
    return ec.generate_private_key(ec.SECP256R1())

def write(name, k, cert):
    open(f"{name}.key", "wb").write(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    open(f"{name}.pem", "wb").write(cert.public_bytes(serialization.Encoding.PEM))

ca_key = key()
ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Leadforge Test CA")])
ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
      .serial_number(1).not_valid_before(dt.datetime(2024, 1, 1)).not_valid_after(dt.datetime(2040, 1, 1))
      .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(ca_key, hashes.SHA256()))
write("ca", ca_key, ca)

hosts = ["*.test", "lunaroots.test", "outbackherbals.test", "maplebloom.test", "pawfect.test", "driftwood.test", "kookaburra.test", "healthy.test", "notwoo.test"]
def leaf(name, before, after, serial):
    k = key()
    c = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
         .issuer_name(ca_name).public_key(k.public_key()).serial_number(serial).not_valid_before(before).not_valid_after(after)
         .add_extension(x509.SubjectAlternativeName([x509.DNSName(h) for h in hosts]), critical=False)
         .sign(ca_key, hashes.SHA256()))
    write(name, k, c)

leaf("good", dt.datetime(2024, 1, 1), dt.datetime(2039, 1, 1), 2)
leaf("expired", dt.datetime(2024, 1, 1), dt.datetime(2025, 1, 1), 3)
