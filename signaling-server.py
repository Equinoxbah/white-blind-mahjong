#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
白色失明文字麻将 - 信令服务器 (Python 纯标准库实现)
用法: python signaling-server.py [端口]
默认端口 8765
"""

import asyncio
import json
import hashlib
import base64
import struct
import sys
import os

# ============================================================
# WebSocket 协议实现 (纯标准库)
# ============================================================

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def ws_accept_key(key):
    """计算 Sec-WebSocket-Accept 值"""
    sha1 = hashlib.sha1((key + GUID).encode()).digest()
    return base64.b64encode(sha1).decode()


def parse_ws_frame(data):
    """解析 WebSocket 帧，返回 (fin, opcode, payload_bytes) 或 None"""
    if len(data) < 2:
        return None
    byte1 = data[0]
    byte2 = data[1]
    fin = (byte1 & 0x80) != 0
    opcode = byte1 & 0x0F
    masked = (byte2 & 0x80) != 0
    payload_len = byte2 & 0x7F
    offset = 2

    if payload_len == 126:
        if len(data) < offset + 2:
            return None
        payload_len = struct.unpack(">H", data[offset:offset + 2])[0]
        offset += 2
    elif payload_len == 127:
        if len(data) < offset + 8:
            return None
        payload_len = struct.unpack(">Q", data[offset:offset + 8])[0]
        offset += 8

    mask_key = None
    if masked:
        if len(data) < offset + 4:
            return None
        mask_key = data[offset:offset + 4]
        offset += 4

    if len(data) < offset + payload_len:
        return None

    payload = data[offset:offset + payload_len]
    if masked and mask_key:
        payload = bytes(payload[i] ^ mask_key[i % 4] for i in range(len(payload)))

    return fin, opcode, payload, offset + payload_len


def build_ws_frame(payload_bytes, opcode=0x01):
    """构建 WebSocket 帧 (服务器发送，不 masked)"""
    header = bytearray()
    header.append(0x80 | opcode)  # FIN=1, opcode

    length = len(payload_bytes)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack(">H", length))
    else:
        header.append(127)
        header.extend(struct.pack(">Q", length))

    return bytes(header) + payload_bytes


# ============================================================
# 信令服务器
# ============================================================

class SignalingServer:
    def __init__(self, port=8765):
        self.port = port
        # room_id -> { client_id -> {name, is_creator, seat, ready, writer} }
        self.rooms = {}
        # writer -> (room_id, client_id)
        self.clients = {}

    def get_room(self, room_id):
        if room_id not in self.rooms:
            self.rooms[room_id] = {}
        return self.rooms[room_id]

    def player_list(self, room):
        return [
            {
                "id": cid,
                "name": info["name"],
                "isCreator": info["is_creator"],
                "seat": info["seat"],
                "ready": info.get("ready", False)
            }
            for cid, info in room.items()
        ]

    async def send_to_client(self, writer, message):
        try:
            data = json.dumps(message, ensure_ascii=False).encode("utf-8")
            frame = build_ws_frame(data)
            writer.write(frame)
            await writer.drain()
        except Exception:
            pass

    async def broadcast_to_room(self, room_id, message, exclude_writer=None):
        room = self.rooms.get(room_id, {})
        for cid, info in room.items():
            if info["writer"] is not exclude_writer:
                await self.send_to_client(info["writer"], message)

    async def send_to_target(self, room_id, target_id, message):
        room = self.rooms.get(room_id, {})
        if target_id in room:
            await self.send_to_client(room[target_id]["writer"], message)

    async def handle_message(self, writer, raw_text):
        try:
            msg = json.loads(raw_text)
        except Exception:
            return

        msg_type = msg.get("type")
        if not msg_type:
            return

        if msg_type == "join-room":
            room_id = msg.get("roomId")
            player = msg.get("player", {})
            client_id = player.get("id")
            name = player.get("name", "匿名")
            is_creator = player.get("isCreator", False)
            seat = player.get("seat")

            if not room_id or not client_id:
                return

            # 如果之前在别的房间，先离开
            if writer in self.clients:
                old_room_id, old_cid = self.clients[writer]
                old_room = self.rooms.get(old_room_id, {})
                if old_cid in old_room:
                    del old_room[old_cid]
                    if not old_room:
                        del self.rooms[old_room_id]
                    else:
                        await self.broadcast_to_room(old_room_id, {
                            "type": "room-update",
                            "players": self.player_list(old_room)
                        })

            room = self.get_room(room_id)

            # 分配座位（seat 为 None 或负数时自动分配）
            if seat is None or seat < 0:
                used_seats = {info["seat"] for info in room.values()}
                for i in range(4):
                    if i not in used_seats:
                        seat = i
                        break

            room[client_id] = {
                "name": name,
                "is_creator": is_creator,
                "seat": seat,
                "ready": False,
                "writer": writer
            }
            self.clients[writer] = (room_id, client_id)

            # 告诉新玩家当前房间列表
            await self.send_to_client(writer, {
                "type": "room-joined",
                "players": self.player_list(room)
            })

            # 广播给其他人
            await self.broadcast_to_room(room_id, {
                "type": "room-update",
                "players": self.player_list(room)
            }, exclude_writer=writer)

            print(f"[加入] 房间={room_id} 玩家={name} 座位={seat} 当前{len(room)}人")

        elif msg_type == "ready-change":
            if writer not in self.clients:
                return
            room_id, client_id = self.clients[writer]
            room = self.rooms.get(room_id)
            if room and client_id in room:
                room[client_id]["ready"] = bool(msg.get("ready"))
                await self.broadcast_to_room(room_id, {
                    "type": "room-update",
                    "players": self.player_list(room)
                })

        elif msg_type in ("p2p-offer", "p2p-answer", "p2p-ice"):
            if writer not in self.clients:
                return
            room_id, client_id = self.clients[writer]
            target_id = msg.get("targetId")
            if not target_id:
                return
            forward = {
                "type": msg_type,
                "fromId": client_id,
                "targetId": target_id
            }
            if msg_type == "p2p-offer":
                forward["offer"] = msg.get("offer")
            elif msg_type == "p2p-answer":
                forward["answer"] = msg.get("answer")
            elif msg_type == "p2p-ice":
                forward["candidate"] = msg.get("candidate")
            await self.send_to_target(room_id, target_id, forward)

        elif msg_type == "broadcast":
            if writer not in self.clients:
                return
            room_id, client_id = self.clients[writer]
            await self.broadcast_to_room(room_id, {
                "type": "room-msg",
                "fromId": client_id,
                "payload": msg.get("payload")
            }, exclude_writer=writer)

    async def handle_client(self, reader, writer):
        # 1. 读取 HTTP 请求 (WebSocket 握手)
        try:
            request_line = await reader.readline()
            if not request_line:
                writer.close()
                return

            headers = {}
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                try:
                    key, _, value = line.decode("utf-8", errors="ignore").strip().partition(":")
                    headers[key.strip().lower()] = value.strip()
                except Exception:
                    pass
        except Exception:
            writer.close()
            return

        # 2. 检查是否是 WebSocket 升级请求
        if headers.get("upgrade", "").lower() != "websocket":
            writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            await writer.drain()
            writer.close()
            return

        ws_key = headers.get("sec-websocket-key", "")
        accept_key = ws_accept_key(ws_key)

        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_key}\r\n"
            "\r\n"
        )
        writer.write(response.encode())
        await writer.drain()

        # 3. WebSocket 数据帧循环
        buffer = bytearray()
        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                buffer.extend(chunk)

                while len(buffer) >= 2:
                    result = parse_ws_frame(bytes(buffer))
                    if result is None:
                        break  # 数据不完整，等更多

                    fin, opcode, payload, frame_size = result

                    if opcode == 0x08:  # 连接关闭
                        return
                    if opcode == 0x09:  # Ping
                        pong = build_ws_frame(payload, opcode=0x0A)
                        writer.write(pong)
                        await writer.drain()
                    elif opcode in (0x01, 0x02):  # 文本/二进制
                        text = payload.decode("utf-8", errors="ignore")
                        await self.handle_message(writer, text)

                    # 移除已处理的帧
                    del buffer[:frame_size]
        except Exception:
            pass
        finally:
            # 客户端断开，清理
            if writer in self.clients:
                room_id, client_id = self.clients[writer]
                room = self.rooms.get(room_id, {})
                name = room.get(client_id, {}).get("name", "未知")
                if client_id in room:
                    del room[client_id]
                del self.clients[writer]

                print(f"[离开] 房间={room_id} 玩家={name} 当前{len(room)}人")

                if not room:
                    if room_id in self.rooms:
                        del self.rooms[room_id]
                    print(f"[销毁] 房间={room_id} 已空")
                else:
                    await self.broadcast_to_room(room_id, {
                        "type": "room-update",
                        "players": self.player_list(room)
                    })

            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def start(self):
        server = await asyncio.start_server(self.handle_client, "0.0.0.0", self.port)
        print("=" * 50)
        print("  白色失明文字麻将 - 信令服务器已启动")
        print(f"  端口: {self.port}")
        print(f"  本地地址: ws://localhost:{self.port}")
        print(f"  局域网地址: ws://<你的IP>:{self.port}")
        print(f"  用 ngrok 暴露: ngrok http {self.port}")
        print("  (ngrok 给出 https://xxx.ngrok-free.app，改成 wss://xxx.ngrok-free.app)")
        print("=" * 50)
        async with server:
            await server.serve_forever()


def main():
    port = 8765
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    server = SignalingServer(port)
    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        print("\n服务器已停止")


if __name__ == "__main__":
    main()
