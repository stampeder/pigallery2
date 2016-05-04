import {Pipe, PipeTransform} from "@angular/core";
import {UserRoles} from "../../../common/entities/User";


@Pipe({name: 'stringifyRole'})
export class StringifyRole implements PipeTransform {
    transform(role: string): number {
        return UserRoles[role];
    }
}

