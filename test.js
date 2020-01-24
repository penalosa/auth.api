process.env.NODE_ENV = "test";

let chai = require("chai");
let chaiHttp = require("chai-http");
let server = require("./index");
let should = chai.should();

chai.use(chaiHttp);

describe("/register", () => {
  it("Fail on empty response body", done => {
    chai
      .request(server)
      .post("/register")
      .end((err, res) => {
        res.should.have.status(400);
        done();
      });
  });
  it("Fail on duplicate email", done => {
    chai
      .request(server)
      .post("/register")
      .send({
        data: {
          personal_details: {
            email: "samuel@macleod.space",
            name: "Samuel Macleod"
          },
          user_pic: ""
        }
      })
      .end((err, res) => {
        res.should.have.status(409);
        done();
      });
  });
});

describe("/login", () => {
  it("Fail on empty response body", done => {
    chai
      .request(server)
      .post("/register")
      .end((err, res) => {
        res.should.have.status(400);
        done();
      });
  });
  it("Fail on duplicate email", done => {
    chai
      .request(server)
      .post("/register")
      .send({
        data: {
          personal_details: {
            email: "samuel@macleod.space",
            name: "Samuel Macleod"
          },
          user_pic: ""
        }
      })
      .end((err, res) => {
        res.should.have.status(409);
        done();
      });
  });
});
