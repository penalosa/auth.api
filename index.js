const mongoose = require("mongoose");
const express = require("express");
const fetch = require("node-fetch");
const AWS = require("aws-sdk");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const md5 = require("md5");
const app = express();
app.use(cors());
const FormData = require("form-data");
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
const User = mongoose.model(
  `User`,
  new mongoose.Schema(
    {
      ghost_cookie: String,
      name: String,
      pic: String,
      slug: String,
      role: String
    },
    {
      typePojoToMixed: false,
      typeKey: "$type",
      timestamps: true
    }
  )
);
const GhostAdminAPI = require("@tryghost/admin-api");

mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/prod", {
  useNewUrlParser: true
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
app.get("/import", async (req, res) => {
  const api = new GhostAdminAPI({
    url: "https://content.freshair.org.uk",
    key: ghostToken,
    version: "v3"
  });

  res.json(
    (await api.users.browse({ limit: "all", include: "roles" })).map(u => ({
      name: u.name,
      pic: u.profile_image,
      slug: u.slug,
      role: u.roles[0].title
    }))
  );
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

app.use(express.json());
app.post("/register", async (req, res) => {
  console.log("Register");
  console.log(req.body);
  let {
    personal_details: { email, name },
    user_pic
  } = req.body.data;
  console.log(email, name, user_pic);
  let auth = await ghostRequest("/authentication/create", "POST", {
    email,
    name,
    pic: user_pic
  });
  return res.json(auth);
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
      return res.status(401).send();
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
      await User.findOneAndUpdate({ slug: data.slug }, projection, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      });
      return res.json({ ...projection, token });
    } else {
      console.log("Other", auth.status);
      return res.status(500).send(await auth.text());
    }
  } catch (e) {
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
    return res.json(await User.find({}, ["name", "pic", "slug"]));
  } catch (e) {
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
app.listen(port, () => console.log(`auth.api listening on port ${port}!`));
