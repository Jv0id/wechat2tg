import {promisify} from 'util'

const sleep = promisify(setTimeout)

export class SimpleMessageSendQueueHelper {
    private sendFunction: (...args) => Promise<any>
    private interval: number
    private messageQueue: SendMessageWarps[] = []
    private loopTime = 503

    constructor(sendFunction: (...args) => Promise<any>, interval: number) {
        this.sendFunction = sendFunction
        this.interval = interval
        this.startSend()
    }

    public addMessage(...message: any): void {
        const sendMessage = {
            msgId: new Date().getTime(),
            success: false,
            time: new Date(),
            message: message,
            sending: false,
        }
        this.messageQueue.push(sendMessage)
    }

    private startSend(): void {
        setInterval(async () => {
            await this.processQueue()
        }, this.loopTime)
    }

    private async processQueue(): Promise<void> {
        while (this.messageQueue.length > 0) {
            const sendMessage = this.messageQueue.shift()
            if (sendMessage && sendMessage.success !== true && sendMessage.sending !== true) {
                sendMessage.sending = true
                await this.sendFunction(...sendMessage.message).then(() => {
                    sendMessage.success = true
                    sendMessage.sending = false
                }).catch(() => {
                    this.sendFunction(...sendMessage.message).then(() => {
                        sendMessage.success = true
                        sendMessage.sending = false
                    })
                }).finally(() => {
                    sendMessage.sending = false
                })
                await sleep(this.interval)
            } else if (!sendMessage.success && sendMessage.time.getTime() + this.interval * 7 < new Date().getTime()) {
                await sleep(this.interval)
                this.messageQueue.push(sendMessage)
            }
        }

    }
}

export interface SendMessageWarps {
    msgId: number | string,
    success: boolean,
    sending: boolean,
    time: Date,
    message: any[],
}