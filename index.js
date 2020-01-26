const express = require("express");
const fetch = require("node-fetch");
const AWS = require("aws-sdk");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const md5 = require("md5");

const app = express();
app.use(cors());
const jwt = require("jsonwebtoken");
const port = process.env.PORT || 8007;
const spacesEndpoint = new AWS.Endpoint("nyc3.digitaloceanspaces.com");
const ghostBase =
  process.env.GHOST_URI || "http://localhost:2368/ghost/api/canary/admin";
const jwtSecret = process.env.JWT_SECRET || "This book will chnage your life";
const ghostToken = process.env.GHOST_TOKEN;
const ghostRequest = async (path, method = "GET", body, retries = 3) => {
  const [id, secret] = ghostToken.split(":");
  const token = await sign({}, Buffer.from(secret, "hex"), {
    keyid: id,
    algorithm: "HS256",
    expiresIn: "5m",
    audience: `/canary/admin/`
  });

  let req = await fetch(`${ghostBase}${path}`, {
    ...(body ? { body: JSON.stringify(body) } : {}),
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Ghost ${token}`
    }
  });
  console.log();
  console.log(`${path} ${req.status} ${retries}`);
  let json = await req.json();
  if (req.status == 500) console.log(json);
  if (req.status == 500 && retries > 0) {
    return await ghostRequest(path, method, body, retries - 1);
  } else {
    return json;
  }
};
const sign = (data, s = jwtSecret) =>
  new Promise((yes, no) => {
    jwt.sign(data, s, (err, token) => {
      if (err) return no(err);
      yes(token);
    });
  });
const verify = token =>
  new Promise((yes, no) => {
    jwt.verify(token, jwtSecret, (err, decoded) => {
      if (err) return no(err);
      yes(decoded);
    });
  });

const GhostAdminAPI = require("@tryghost/admin-api");
const Admin = new GhostAdminAPI({
  url: "https://content.freshair.org.uk",
  key: ghostToken,
  version: "v3"
});

const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.ACCESS_KEY,
  secretAccessKey: process.env.SECRET_KEY
});

const upload = multer({
  dest: "/tmp",
  limits: { fileSize: 524288000 }
});

app.post("/upload", upload.single("upload"), async (req, res) => {
  if (!req.file) {
    return res.status(400);
  }
  let data = await fs.readFile(req.file.path);
  let name = md5(data);
  const params = {
    Body: data,
    Bucket: "freshair",
    Key: `upload/${name}`,
    ACL: "public-read",
    ContentType: "audio/mpeg"
  };
  res.send(name);
  s3.putObject(params, (err, data) => {
    if (err) console.error(err, err.stack);
    else {
      console.log(`Uploaded: ${name}`);
    }
  });
});
const morgan = require("morgan");
app.use(morgan("combined"));
app.use(express.json());

app.post("/register", async (req, res) => {
  try {
    let {
      personal_details: { email, name },
      user_pic
    } = req.body.data;
    const auth = await fetch(`${ghostBase}/authentication/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://auth.api.freshair.org.uk"
      },
      body: JSON.stringify({
        email,
        name,
        pic: user_pic
      })
    });
    let json = await auth.json();
    if (json.errors) {
      if (json.errors.find(e => e.code == "SQLITE_CONSTRAINT")) {
        return res.sendStatus(409);
      }
      console.error(json);

      return res.status(500).send(json);
    }
    return res.json(auth);
  } catch (e) {
    if (e instanceof TypeError) {
      return res.sendStatus(400);
    }
    console.error(e);

    return res.status(500).send(e);
  }
});
app.post("/login", async (req, res) => {
  console.log("LOGIN");
  let { username, password } = req.body;
  try {
    const auth = await fetch(`${ghostBase}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://auth.api.freshair.org.uk"
      },
      body: JSON.stringify({
        username,
        password
      })
    });
    console.log(auth.status);
    if (auth.status == 401) {
      let json = await auth.json();
      console.error(json);
      if (json.errors.find(e => e.code)) {
        return res.status(401).json(json);
      }
      try {
        let exists = await Admin.users.read({ email: username });
        const reset = await fetch(`${ghostBase}/authentication/passwordreset`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://auth.api.freshair.org.uk"
          },
          body: JSON.stringify({
            passwordreset: [{ email: username }]
          })
        });
        console.log(await reset.json());
        return res.status(423).json(json);
      } catch (e) {
        return res.status(404).json(json);
      }
    } else if (auth.status == 429) {
      let json = await auth.json();
      console.error(json);
      return res.status(429).json(json);
    } else if (auth.status == 201) {
      console.log(201);
      const cookie = auth.headers.raw()["set-cookie"];
      const me = await fetch(`${ghostBase}/users/me/?include=roles`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://auth.api.freshair.org.uk",
          Cookie: cookie[0]
        }
      });
      let data = (await me.json()).users[0];
      console.log(cookie);
      let projection = {
        name: data.name,
        slug: data.slug,
        pic: data.profile_image,
        role: data.roles[0].name,
        ghost_cookie: cookie[0]
      };
      let token = await sign(projection);
      return res.json({ ...projection, token });
    } else {
      console.error("Other", auth.status);
      let text = await auth.text();
      console.error(text);
      return res.status(500).send(await auth.text());
    }
  } catch (e) {
    console.error(e);
    return res.status(500).send(e);
  }
});
app.post("/verify", async (req, res) => {
  const token = req.headers["x-auth-token"];
  try {
    let data = await verify(token);
    return res.json({ ...data, ok: true });
  } catch (e) {
    console.log(e);
    return res.json({ ok: false });
  }
});
app.get("/list", async (req, res) => {
  try {
    const users = await Admin.users.browse({ limit: "all", include: "roles" });
    return res.json(
      users.map(u => ({
        name: u.name,
        pic: u.profile_image,
        slug: u.slug,
        role: u.roles[0].name
      }))
    );
  } catch (e) {
    console.error(e);
    return res.status(500).send(e);
  }
});
app.get("/redirect/:app", async (req, res) => {
  let app = req.params.app;
  return res.json(
    {
      forms: {
        redirect: "https://forms.freshair.org.uk/token/"
      }
    }[app] || { error: true }
  );
});
module.exports = app.listen(port, () =>
  console.log(`auth.api listening on port ${port}!`)
);
