/*!
 * chain.js - blockchain management for hsk
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshakecompany/hsk
 */

'use strict';

const bio = require('bufio');
const Outpoint = require('../primitives/outpoint');
const consensus = require('../protocol/consensus');
const rules = require('./rules');
const {ZERO_HASH} = consensus;
const {encoding} = bio;

/*
 * Constants
 */

const states = {
  BIDDING: 0,
  REVEAL: 1,
  CLOSED: 2
};

const types = {
  SET_AUCTION: 0,
  SET_OWNER: 1,
  SET_REVOKE: 2,
  SET_DATA: 3,
  SET_RENEWAL: 4,
  SET_CLAIMED: 5
};

const EMPTY = Buffer.alloc(0);

/**
 * Op
 */

class Op {
  constructor(type, params) {
    this.type = type || 0;
    this.params = params || [];
  }

  getSize() {
    switch (this.type) {
      case types.SET_AUCTION: {
        const [state] = this.params;
        return 1 + state.getSize();
      }
      case types.SET_OWNER: {
        const [owner] = this.params;
        return 1 + 1 + (!owner.isNull() ? 36 + 8 : 0);
      }
      case types.SET_REVOKE: {
        const [revoke] = this.params;
        return 1 + 1 + (!revoke.isNull() ? 36 : 0);
      }
      case types.SET_DATA: {
        const [data] = this.params;
        return 1 + 1 + (data ? encoding.sizeVarlen(data.length) : 0);
      }
      case types.SET_RENEWAL: {
        return 1 + 4;
      }
      case types.SET_CLAIMED: {
        return 1 + 1;
      }
      default: {
        throw new Error('Bad op type.');
      }
    }
  }

  toWriter(bw) {
    bw.writeU8(this.type);
    switch (this.type) {
      case types.SET_AUCTION: {
        const [state] = this.params;
        state.toWriter(bw);
        break;
      }
      case types.SET_OWNER: {
        const [owner, value] = this.params;
        if (!owner.isNull()) {
          bw.writeU8(1);
          owner.toWriter(bw);
          bw.writeU64(value);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_REVOKE: {
        const [revoke] = this.params;
        if (!revoke.isNull()) {
          bw.writeU8(1);
          revoke.toWriter(bw);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_DATA: {
        const [data] = this.params;
        if (data) {
          bw.writeU8(1);
          bw.writeVarBytes(data);
        } else {
          bw.writeU8(0);
        }
        break;
      }
      case types.SET_RENEWAL: {
        const [renewal] = this.params;
        bw.writeU32(renewal);
        break;
      }
      case types.SET_CLAIMED: {
        const [claimed] = this.params;
        bw.writeU8(claimed ? 1 : 0);
        break;
      }
      default: {
        throw new Error('Bad op type.');
      }
    }
    return bw;
  }

  toRaw() {
    const size = this.getSize();
    return this.toWriter(bio.write(size)).render();
  }

  fromReader(br) {
    this.type = br.readU8();
    switch (this.type) {
      case types.SET_AUCTION: {
        this.params.push(Auction.fromReader(br));
        break;
      }
      case types.SET_OWNER: {
        if (br.readU8() === 1) {
          this.params.push(Outpoint.fromReader(br));
          this.params.push(br.readU64());
        } else {
          this.params.push(new Outpoint());
          this.params.push(0);
        }
        break;
      }
      case types.SET_REVOKE: {
        if (br.readU8() === 1)
          this.params.push(Outpoint.fromReader(br));
        else
          this.params.push(new Outpoint());
        break;
      }
      case types.SET_DATA: {
        if (br.readU8() === 1)
          this.params.push(br.readVarBytes());
        else
          this.params.push(null);
        break;
      }
      case types.SET_RENEWAL: {
        this.params.push(br.readU32());
        break;
      }
      case types.SET_CLAIMED: {
        this.params.push(br.readU8() === 1);
        break;
      }
      default: {
        throw new Error('Bad op type.');
      }
    }
    return this;
  }

  fromRaw(data) {
    return this.fromReader(bio.read(data));
  }

  static fromReader(br) {
    return new this().fromReader(br);
  }

  static fromRaw(data) {
    return new this().fromRaw(data);
  }
}

/**
 * Auction
 */

class Auction {
  constructor() {
    this.name = EMPTY;
    this.nameHash = ZERO_HASH;
    this.owner = new Outpoint();
    this.value = 0;
    this.revoke = new Outpoint();
    this.data = null;
    this.height = 0;
    this.renewal = 0;
    this.claimed = false;

    // Not serialized.
    this.ops = [];
    this.undo = [];
  }

  clone() {
    const copy = new this.constructor();
    return copy.inject(this);
  }

  inject(auction) {
    this.name = auction.name;
    this.nameHash = auction.nameHash;
    this.owner = auction.owner;
    this.value = auction.value;
    this.revoke = auction.revoke;
    this.data = auction.data;
    this.height = auction.height;
    this.renewal = auction.renewal;
    this.claimed = auction.claimed;
    return this;
  }

  isNull() {
    return this.owner.isNull()
      && this.value === 0
      && this.revoke.isNull()
      && this.data === null
      && this.height === 0
      && this.renewal === 0
      && this.claimed === false;
  }

  setNull() {
    this.owner = new Outpoint();
    this.value = 0;
    this.revoke = new Outpoint();
    this.data = null;
    this.height = 0;
    this.renewal = 0;
    this.claimed = false;
    return this;
  }

  state(height, network) {
    if (this.claimed)
      return states.CLOSED;

    if (height < this.height + rules.BIDDING_PERIOD)
      return states.BIDDING;

    if (height < this.height + rules.TOTAL_PERIOD)
      return states.REVEAL;

    return states.CLOSED;
  }

  isBidding(height, network) {
    return this.state(height, network) === states.BIDDING;
  }

  isReveal(height, network) {
    return this.state(height, network) === states.REVEAL;
  }

  isClosed(height, network) {
    return this.state(height, network) === states.CLOSED;
  }

  isExpired(height, network) {
    // Can only renew once we reach the closed state.
    if (!this.isClosed(height, network))
      return false;

    // If we haven't been renewed in a year, start over.
    if (height >= this.renewal + rules.RENEWAL_WINDOW)
      return true;

    // If nobody revealed their bids, start over.
    if (this.owner.isNull() && this.revoke.isNull())
      return true;

    return false;
  }

  isLocal(view, prevout) {
    const entry = view.getEntry(prevout);

    if (!entry)
      return true;

    if (entry.height === -1)
      return true;

    return entry.height >= this.height;
  }

  setAuction(name, height) {
    this.name = name;

    if (this.data) {
      this.undo.push(new Op(types.SET_DATA, [this.data]));
      this.ops.push(new Op(types.SET_DATA, [null]));
    }

    this.undo.push(new Op(types.SET_AUCTION, [this.clone()]));
    this.ops.push(new Op(types.SET_AUCTION, [this]));

    this.setNull();
    this.height = height;
    this.renewal = height;

    return this;
  }

  setOwner(owner, value) {
    this.undo.push(new Op(types.SET_OWNER, [this.owner, this.value]));
    this.ops.push(new Op(types.SET_OWNER, [owner, value]));
    this.owner = owner;
    this.value = value;
    return this;
  }

  setRevoke(revoke) {
    this.undo.push(new Op(types.SET_REVOKE, [this.revoke]));
    this.ops.push(new Op(types.SET_REVOKE, [revoke]));
    this.revoke = revoke;
    return this;
  }

  setData(data) {
    this.undo.push(new Op(types.SET_DATA, [this.data]));
    this.ops.push(new Op(types.SET_DATA, [data]));
    this.data = data;
    return this;
  }

  setRenewal(renewal) {
    this.undo.push(new Op(types.SET_RENEWAL, [this.renewal]));
    this.ops.push(new Op(types.SET_RENEWAL, [renewal]));
    this.renewal = renewal;
    return this;
  }

  setClaimed(claimed) {
    this.undo.push(new Op(types.SET_CLAIMED, [this.claimed]));
    this.ops.push(new Op(types.SET_CLAIMED, [claimed]));
    this.claimed = claimed;
    return this;
  }

  getSize() {
    let size = 0;

    size += 1 + this.name.length;

    size += 1;
    if (!this.owner.isNull())
      size += 36 + 8;

    size += 1;
    if (!this.revoke.isNull())
      size += 36;

    size += 1;
    if (this.data)
      size += encoding.sizeVarlen(this.data.length);

    size += 4 + 4;
    size += 1;
    return size;
  }

  toRaw() {
    const bw = bio.write(this.getSize());
    return this.toWriter(bw).render();
  }

  toWriter(bw) {
    bw.writeU8(this.name.length);
    bw.writeBytes(this.name);

    if (!this.owner.isNull()) {
      bw.writeU8(1);
      this.owner.toWriter(bw);
      bw.writeU64(this.value);
    } else {
      bw.writeU8(0);
    }

    if (!this.revoke.isNull()) {
      bw.writeU8(1);
      this.revoke.toWriter(bw);
    } else {
      bw.writeU8(0);
    }

    if (this.data) {
      bw.writeU8(1);
      bw.writeVarBytes(this.data);
    } else {
      bw.writeU8(0);
    }

    bw.writeU32(this.height);
    bw.writeU32(this.renewal);
    bw.writeU8(this.claimed ? 1 : 0);

    return bw;
  }

  static fromReader(br) {
    const auction = new this();

    auction.name = br.readBytes(br.readU8());

    if (br.readU8() === 1) {
      auction.owner.fromReader(br);
      auction.value = br.readU64();
    }

    if (br.readU8() === 1)
      auction.revoke.fromReader(br);

    if (br.readU8() === 1)
      auction.data = br.readVarBytes();

    auction.height = br.readU32();
    auction.renewal = br.readU32();
    auction.claimed = br.readU8() === 1;

    return auction;
  }

  static fromRaw(data) {
    const br = bio.read(data);
    return this.fromReader(br);
  }

  toJSON(height, network) {
    return {
      name: this.name.toString('ascii'),
      state: this.state(height, network),
      owner: this.owner.toJSON(),
      value: this.value,
      revoke: this.revoke.toJSON(),
      data: this.data ? this.data.toString('hex') : null,
      height: this.height,
      renewal: this.renewal,
      claimed: this.claimed
    };
  }
}

Auction.states = states;
Auction.types = types;
Auction.Op = Op;

/*
 * Expose
 */

module.exports = Auction;