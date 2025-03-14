import {TelegramClient} from './TelegramClient'
import {TelegramBotClient} from './TelegramBotClient'
import * as authMethods from 'telegram/client/auth'
import {StoreSession} from 'telegram/sessions'
import {Api} from 'telegram'
import {config} from '../config'
import {TelegramClient as GramClient} from 'telegram/client/TelegramClient'
import {BigInteger} from 'big-integer'
import {CreateGroupInterface} from '../model/CreateGroupInterface'
import {CustomFile} from 'telegram/client/uploads'
import {SetupServiceImpl} from '../service/impl/SetupServiceImpl'
import * as os from 'node:os'
import {NewMessage, NewMessageEvent} from 'telegram/events'
import {MessageService} from '../service/MessageService'
import {Snowflake} from 'nodejs-snowflake'
import {SimpleMessageSender} from '../model/Message'
import AllowForwardService from '../service/AllowForawrdService'
import {FileBox} from 'file-box'
import {returnBigInt} from 'telegram/Helpers'
import {ConverterHelper} from '../util/FfmpegUtils'
import fs from 'node:fs'
import crypto from 'crypto'
import sharp from 'sharp'
import {ContactInterface, MessageInterface, RoomInterface} from 'wechaty/dist/esm/src/mods/impls'
import {WeChatClient} from './WechatClient'
import {AllowForward} from '../model/AllowForwardEntity'
import {MessageUtils} from '../util/MessageUtils'
import {DeletedMessage} from 'telegram/events/DeletedMessage'


export class TelegramUserClient extends TelegramClient {
    private static telegramUserInstance: TelegramUserClient
    private _allowForwardService = AllowForwardService.getInstance()
    private allAllowForward: AllowForward[] = []

    private constructor(telegramBotClient: TelegramBotClient) {
        super(telegramBotClient)
        this.initAllowForward()
    }

    static getInstance(): TelegramUserClient {
        if (!TelegramUserClient.telegramUserInstance) {
            TelegramUserClient.telegramUserInstance = new TelegramUserClient(TelegramBotClient.getInstance())
        }
        return TelegramUserClient.telegramUserInstance
    }

    protected init() {
        // 子类重写init方法
        if (this.apiId && this.apiHash) {

            this._client = new GramClient(new StoreSession('storage/tg-user-session'), this.apiId, this.apiHash, {
                connectionRetries: 1000000,
                deviceModel: `${config.APP_NAME} User On ${os.hostname()}`,
                appVersion: 'rainbowcat',
                proxy: config.HOST ? {
                    ip: config.HOST,
                    port: parseInt(config.PORT),
                    socksType: 5,
                    password: config.PASSWORD,
                    username: config.USERNAME,
                } : undefined,
                autoReconnect: true,
                maxConcurrentDownloads: 3,
            })
        }
    }

    public async start(authParams: authMethods.UserAuthParams | authMethods.BotAuthParams) {
        if (!await this._client?.checkAuthorization()) {
            this._client?.start(authParams).then(res=>{
                this.loginSuccessHandle()
            }).catch((e) => {
                this.telegramBotClient.tgUserClientLogin = false
                this.logError('login... user error', e)
            })
        } else {
            setTimeout(() => this.loginSuccessHandle(), 500)
        }
        return this._client
    }

    private loginSuccessHandle() {
        this._client?.addEventHandler(async event => {
            // let id = event.peer?.id
            // this.logInfo(`Deleted message: ${event.inputChat}`)
            for (const deletedId of event.deletedIds) {
                MessageUtils.undoMessage(deletedId)
            }
        }, new DeletedMessage({}))
        this.telegramBotClient.tgUserClientLogin = true
        const setupServiceImpl = new SetupServiceImpl()
        setupServiceImpl.createFolder().then(() => {
            TelegramBotClient.getInstance().bindItemService.getAllBindItems().then(async (bindItems) => {
                for (const bindItem of bindItems) {
                    await setupServiceImpl.addToFolder(bindItem.chat_id)
                }
                setTimeout(() => {
                    this.telegramBotClient.bot.telegram.sendMessage(this.telegramBotClient.chatId, this.t('common.tgLoginSuccess')).then(msg => {
                        setTimeout(() => {
                            this.telegramBotClient.bot.telegram.deleteMessage(this.telegramBotClient.chatId, msg.message_id)
                        }, 10000)
                    })
                }, 3000)
            })

        })
        this.onMessage()
    }

    public initAllowForward() {
        this._allowForwardService.all().then(all => {
            this.allAllowForward = all
        })
    }

    public updateAllAllowForward() {
        this._allowForwardService.all().then(all => {
            this.allAllowForward = all
            this.onMessage()
        })
    }

    public async onMessage() {
        TelegramBotClient.getInstance().bindItemService.getAllBindItems().then(allBinds => {
            const chatIds = allBinds.flatMap(it => {
                if (parseInt(it.has_bound.toString(10)) === 1) {
                    return it.chat_id
                } else {
                    return []
                }
            })
            if (chatIds?.length > 0) {
                this.client?.getMe().then(me => {
                    const mineId = me.id
                    this.client.addEventHandler(async event => {
                        const msg = event.message
                        if (msg.fromId instanceof Api.PeerUser && msg.fromId.userId.eq(mineId)) {
                            // 我发送的消息
                            const msg = event.message
                            TelegramBotClient.getInstance().bindItemService.getAllBindItems().then(binds => {
                                const msgChatId = msg.chatId?.toJSNumber()
                                if (msgChatId == this.telegramBotClient.chatId || binds.find(it => it.chat_id == msgChatId)) {
                                    MessageService.getInstance().addMessage({
                                        chat_id: msgChatId?.toString(),
                                        msg_text: msg.text,
                                        create_time: Date.now(),
                                        telegram_user_message_id: msg.id,
                                        sender_id: this.telegramBotClient.weChatClient.client.currentUser.id,
                                    })
                                }
                            })
                            return
                        }
                        const botId = returnBigInt(TelegramBotClient.getInstance().botId)
                        const chatIds = this.allAllowForward.map(it => it.chat_id)
                        const msgChatId = msg.chatId?.toJSNumber()
                        if (msg.fromId instanceof Api.PeerUser && !msg.fromId.userId.eq(mineId)
                            && !msg.fromId.userId.eq(botId) && chatIds.includes(msgChatId)) {
                            // if (chatIds.includes(msgChatId)) {
                            const allowForward = this.allAllowForward.find(it => it.chat_id == msgChatId)
                            const doSend = (wechatClient: WeChatClient, sayAble: MessageInterface | ContactInterface | RoomInterface) => {
                                // const afterSend = (msgId: number, chatId: number) => {
                                //     // MessageService.getInstance().updateMessageByWechatMsgIdOrChatItem()
                                // }
                                MessageService.getInstance().addMessage({
                                    chat_id: msgChatId?.toString(),
                                    msg_text: msg.text,
                                    create_time: Date.now(),
                                    telegram_user_message_id: msg.id,
                                    sender_id: this.telegramBotClient.weChatClient.client.currentUser.id,
                                })
                                if (msg.message) {
                                    wechatClient.addMessage(sayAble, msg.message, {
                                        msg_id: msg.id,
                                        chat_id: msgChatId,
                                        // afterSend:
                                    })
                                }
                                if (msg.media) {
                                    const fileName = TelegramUserClient.getFileName(msg)
                                    msg.downloadMedia().then((buff) => {
                                        if (Buffer.byteLength(buff) < 100 * 1024 && (fileName?.endsWith('jpg') || fileName?.endsWith('jpeg') || fileName?.endsWith('png'))) {
                                            // 构造包含无用信息的 EXIF 元数据
                                            const exifData = {
                                                IFD0: {
                                                    // 添加一个长字符串作为无用信息
                                                    ImageDescription: '0'.repeat(110_000 - Buffer.byteLength(buff))
                                                }
                                            }
                                            // 保存带有新元数据的图片
                                            sharp(buff)
                                                .toFormat('png')
                                                .withExif(exifData)
                                                .toBuffer()
                                                .then(buffer => {
                                                    const sendFile = FileBox.fromBuffer(buffer, fileName)
                                                    wechatClient.addMessage(sayAble, sendFile, {
                                                        msg_id: msg.id,
                                                        chat_id: msgChatId,
                                                    })
                                                })
                                            return
                                        }
                                        if (fileName.endsWith('.tgs') || fileName.endsWith('.webm') || fileName.endsWith('.webp')) {
                                            const hash = crypto.createHash('md5')
                                            hash.update(buff)
                                            const md5 = hash.digest('hex')
                                            const saveFile = `save-files/${md5}${fileName.slice(fileName.lastIndexOf('.'))}`
                                            const gifFile = `save-files/${md5}.gif`
                                            const lottie_config = {
                                                width: 128,
                                                height: 128
                                            }
                                            // 微信不能发超过1Mb的gif文件
                                            if (saveFile.endsWith('.tgs')) {
                                                lottie_config.width = 512
                                                lottie_config.height = 512
                                            }
                                            fs.writeFile(saveFile, buff, async (err) => {
                                                if (!err) {
                                                    if (!fs.existsSync(gifFile)) {
                                                        if (fileName.endsWith('.tgs')) {
                                                            await new ConverterHelper().tgsToGif(saveFile, gifFile, lottie_config)
                                                        } else if (fileName.endsWith('.webm')) {
                                                            await new ConverterHelper().webmToGif(saveFile, gifFile)
                                                        } else if (fileName.endsWith('.webp')) {
                                                            await new ConverterHelper().webpToGif(saveFile, gifFile)
                                                        }
                                                    }
                                                }
                                                const sendFile = FileBox.fromFile(gifFile)
                                                wechatClient.addMessage(sayAble, sendFile, {
                                                    msg_id: msg.id,
                                                    chat_id: msgChatId,
                                                })
                                            })
                                        } else {
                                            const sendFile = FileBox.fromBuffer(Buffer.from(buff), fileName)
                                            wechatClient.addMessage(sayAble, sendFile, {
                                                msg_id: msg.id,
                                                chat_id: msgChatId,
                                            })
                                        }
                                    })
                                }
                            }
                            const sendMessage = () => TelegramBotClient.getInstance().bindItemService
                                .getBindItemByChatId(allowForward.chat_id).then(bindItem => {
                                    const wechatClient = this.telegramBotClient.weChatClient
                                    if (parseInt(bindItem.forward.toString(10)) == 1) {
                                        if (bindItem.type === 0) {
                                            wechatClient.client.Contact.find({id: bindItem.wechat_id}).then(contact => {
                                                doSend(wechatClient, contact)
                                            })
                                        }
                                        if (bindItem.type === 1) {
                                            wechatClient.client.Room.find({id: bindItem.wechat_id}).then(room => {
                                                doSend(wechatClient, room)
                                            })
                                        }
                                    }
                                })
                            if (allowForward?.all_allow) {
                                sendMessage()
                            } else if (allowForward?.id) {
                                this._allowForwardService.listEntities(allowForward.id).then(entities => {
                                    const entityIds = entities.map(en => en.entity_id)
                                    if (msg.fromId instanceof Api.PeerUser && entityIds.includes(msg.fromId.userId.toJSNumber())) {
                                        sendMessage()
                                    }
                                })
                            }

                        }
                        // }, new NewMessage())
                    }, new NewMessage({chats: chatIds, func: (event) => event.isGroup}))
                })
            }
        })
    }

    private static getFileName(msg: Api.Message) {
        let fileName = undefined
        switch (msg.media.className) {
            case 'MessageMediaDocument':
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                fileName = msg.document?.attributes?.find(attr => attr instanceof Api.DocumentAttributeFilename)?.fileName
                if (!fileName && msg.document.mimeType) {
                    if (msg.document.mimeType.includes('ogg')) {
                        const nowShangHaiZh = new Date().toLocaleString('zh', {
                            timeZone: 'Asia/ShangHai'
                        }).toString().replaceAll('/', '-')
                        fileName = `语音-${nowShangHaiZh.toLocaleLowerCase()}.mp3`
                    } else {
                        fileName = 'file.' + msg.document.mimeType.split('/')[1]
                    }
                }
                break
            case 'MessageMediaPhoto':
                fileName = 'photo.png'
                break
        }
        return fileName
    }

    /**
     * 获取用户名
     */
    public async getUserId() {
        const me = await this._client?.getMe()
        const id = me?.id
        return id
    }

    public async createGroup(createGroupInterface: CreateGroupInterface) {
        // 如果之前存在该实例则重新绑定
        const row = await this.telegramBotClient.bindItemService.reBind(createGroupInterface)
        if (row) {
            return row
        }
        let bindItem
        if (this.telegramBotClient.botId) {
            let name
            let avatar
            if (createGroupInterface.type === 0) {
                if (createGroupInterface.contact?.payload) {
                    name = SimpleMessageSender.transformTitleStr(config.CREATE_CONTACT_NAME, createGroupInterface.contact?.payload.alias, createGroupInterface.contact?.payload.name, '')
                    avatar = createGroupInterface.contact?.avatar()
                }
            } else {
                if (createGroupInterface.room?.payload) {
                    name = SimpleMessageSender.transformTitleStr(config.CREATE_ROOM_NAME, '', '', createGroupInterface.room.payload.topic)
                }
            }
            // TODO: ROOM NOT READY
            if (!name) {
                name = '微信-未命名群'
            }
            this.logDebug('createGroup id  ', this.telegramBotClient.chatId, this.telegramBotClient.botId)
            if (!this._client?.connected) {
                await this._client?.connect()
                return undefined
            }
            const result = await this.client?.invoke(
                new Api.messages.CreateChat({
                    users: [this.telegramBotClient.chatId, this.telegramBotClient.botId],
                    title: name,
                    ttlPeriod: 0
                })
            )
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const id = result?.updates.chats[0].id
            // 设置管理员
            this.setAdmin(id)
            const setupServiceImpl = new SetupServiceImpl()
            await setupServiceImpl.addToFolder(TelegramUserClient.idConvert(id))
            avatar?.then((fBox) => {
                fBox.toBuffer().then(async (buff) => {
                    const toUpload = new CustomFile(fBox.name, buff.length, '', buff)
                    const file = await this.client?.uploadFile({
                        file: toUpload,
                        workers: 3,
                    })
                    this.client?.invoke(new Api.messages.EditChatPhoto(
                        {
                            chatId: id,
                            photo: new Api.InputChatUploadedPhoto(
                                {
                                    file: file,
                                }
                            )
                        }
                    ))
                })
            })

            // 添加绑定
            if (createGroupInterface.type === 0) {
                // TODO: 公众号合并
                // if (createGroupInterface.contact.type() === ContactType.Official) {
                //     bindItem = this.telegramBotClient.bindItemService.bindGroup(
                //         '订阅号',
                //         TelegramUserClient.idConvert(id), createGroupInterface.type,
                //         createGroupInterface.bindId ? createGroupInterface.bindId : '',
                //         '',
                //         createGroupInterface.contact?.id ? createGroupInterface.contact?.id : '',
                //         '')
                // } else {
                bindItem = this.telegramBotClient.bindItemService.bindGroup(
                    {
                        name: createGroupInterface.contact?.payload?.name ? createGroupInterface.contact?.payload.name : '',
                        chat_id: TelegramUserClient.idConvert(id),
                        type: createGroupInterface.type,
                        bind_id: createGroupInterface.bindId ? createGroupInterface.bindId : '',
                        alias: createGroupInterface.contact?.payload?.alias ? createGroupInterface.contact?.payload?.alias : '',
                        wechat_id: createGroupInterface.contact?.id ? createGroupInterface.contact?.id : '',
                        avatar: createGroupInterface.contact?.payload?.avatar ? createGroupInterface.contact?.payload?.avatar : ''
                    })
                // }
            } else { // room
                const topic = await createGroupInterface.room?.topic()
                bindItem = this.telegramBotClient.bindItemService.bindGroup({
                    name: topic ? topic : '',
                    chat_id: TelegramUserClient.idConvert(id),
                    type: createGroupInterface.type,
                    bind_id: createGroupInterface.bindId ? createGroupInterface.bindId : '',
                    alias: '',
                    wechat_id: createGroupInterface.room?.id ? createGroupInterface.room?.id : '',
                    avatar: createGroupInterface.room?.payload.avatar,
                    room_number: createGroupInterface.room?.payload.memberIdList.length
                })
            }
        }
        return bindItem
    }

    public static idConvert(chatId: BigInteger) {
        // id转换,将telegram api的chat id转为telegram bot的id
        return 0 - Number(chatId)
    }

    public setAdmin(chatId: BigInteger) {
        // 设置管理员
        if (this.telegramBotClient.botId) {
            this.client?.invoke(
                new Api.messages.EditChatAdmin({
                    chatId: chatId,
                    userId: this.telegramBotClient.botId,
                    isAdmin: true
                })
            )
        }
    }

    public async editMessage(inputPeer: { chat_id: number, msg_id: number }, messageText: string) {
        const inputPeerChannelFromMessage = await this?.client?.getInputEntity(inputPeer.chat_id) || inputPeer.chat_id
        return this?.client?.editMessage(
            inputPeerChannelFromMessage,
            {message: inputPeer.msg_id, text: messageText})

    }
}